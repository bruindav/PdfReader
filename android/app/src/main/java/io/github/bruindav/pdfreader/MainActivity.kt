// fix-3
// PdfReader voor Android: een WebView-schil rond de web-app op https://bruindav.github.io/PdfReader/.
// - Verschijnt in "Openen met" en "Delen" voor PDF's en kan standaard-PDF-app worden.
// - Geeft de bytes van het gekozen bestand door aan de web-app via een berichtenbrug
//   (WebViewCompat.addWebMessageListener, alleen voor de origin https://bruindav.github.io).
// - Opslaan/delen vanuit de web-app gaat terug via dezelfde brug naar de Android-mapkiezer of het deelmenu.
package io.github.bruindav.pdfreader

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.RenderProcessGoneDetail
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MainActivity : ComponentActivity() {

    companion object {
        const val START_URL = "https://bruindav.github.io/PdfReader/"
        const val HOST = "bruindav.github.io"
        const val ORIGIN = "https://$HOST"
        const val PATH_PREFIX = "/PdfReader/"
        const val BRIDGE_NAME = "PdfReaderAndroid"
        const val MAX_BYTES = 200L * 1024 * 1024
        const val CHUNK = 512 * 1024
        const val PDF_MIME = "application/pdf"
    }

    /** Een PDF die de web-app naar ons stuurt om op te slaan of te delen. */
    private class Upload(
        val id: Int,
        val name: String,
        val action: String,
        val file: File,
        val out: FileOutputStream,
    ) {
        var written = 0L // alleen op de hoofdthread
        @Volatile var failed = false
        @Volatile var tooBig = false
    }

    private lateinit var webView: WebView
    private lateinit var errorView: View
    private lateinit var statusSpacer: View
    private lateinit var root: LinearLayout

    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val fileIds = AtomicInteger(1)

    private var bridgeSupported = false
    private var binarySupported = false
    private var replyProxy: JavaScriptReplyProxy? = null
    private var pendingUri: Uri? = null
    private var upload: Upload? = null
    private var awaitingSave: Upload? = null
    private var chooserCallback: ValueCallback<Array<Uri>>? = null
    private var mainFrameError = false

    private val createDocument =
        registerForActivityResult(ActivityResultContracts.CreateDocument(PDF_MIME)) { uri -> onCreateDocumentResult(uri) }

    private val openDocument =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> onOpenDocumentResult(uri) }

    // ---------------------------------------------------------------- levenscyclus

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        cleanTempDirs()
        buildLayout()
        configureWebView()
        configureServiceWorkers()
        installBridge()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        if (savedInstanceState == null) handleIntent(intent)
        webView.loadUrl(START_URL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Donkere/lichte modus wisselt zonder herstart (configChanges=uiMode).
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.pdfreader_achtergrond))
    }

    override fun onDestroy() {
        chooserCallback?.onReceiveValue(null)
        chooserCallback = null
        upload?.let { up -> io.execute { closeQuietly(up); up.file.delete() } }
        upload = null
        io.shutdown()
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    // ---------------------------------------------------------------- opbouw

    private fun buildLayout() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.pdfreader_achtergrond))
        }
        statusSpacer = View(this).apply {
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.pdfreader_blauw))
        }
        root.addView(statusSpacer, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0))

        val content = FrameLayout(this)
        webView = WebView(this)
        content.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        errorView = buildErrorView()
        content.addView(errorView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        // Edge-to-edge: zelf ruimte maken voor statusbalk, navigatiebalk, camera-uitsparing en toetsenbord.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            statusSpacer.layoutParams = statusSpacer.layoutParams.apply { height = bars.top }
            v.setPadding(bars.left, 0, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
    }

    private fun buildErrorView(): View {
        val pad = (24 * resources.displayMetrics.density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.pdfreader_achtergrond))
            visibility = View.GONE
            isClickable = true
            addView(TextView(this@MainActivity).apply {
                setText(R.string.geen_verbinding)
                textSize = 17f
                gravity = Gravity.CENTER
            })
            addView(Button(this@MainActivity).apply {
                setText(R.string.opnieuw)
                setOnClickListener {
                    errorView.visibility = View.GONE
                    if (webView.url.isNullOrEmpty()) webView.loadUrl(START_URL) else webView.reload()
                }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = pad
            })
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true // localStorage; IndexedDB en service workers werken standaard
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            // Zoomen (knijpen) doet de web-app zelf.
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (isAppUrl(url)) return false
                if (request.isForMainFrame) openExternal(url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                mainFrameError = false
                // Nieuwe pagina: oude brug-verbinding en half ontvangen uploads zijn ongeldig.
                replyProxy = null
                abortUpload()
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (!mainFrameError) errorView.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    mainFrameError = true
                    errorView.visibility = View.VISIBLE
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // WebView-proces gestopt: opnieuw opbouwen in plaats van de app te laten crashen.
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                recreate()
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: WebChromeClient.FileChooserParams,
            ): Boolean {
                chooserCallback?.onReceiveValue(null)
                chooserCallback = null
                if (bridgeSupported) {
                    // Het bestand komt via de brug binnen (zelfde route als "Openen met");
                    // de WebView zelf krijgt geen toegang tot content://-adressen.
                    filePathCallback.onReceiveValue(null)
                } else {
                    chooserCallback = filePathCallback
                }
                try {
                    openDocument.launch(arrayOf(PDF_MIME))
                } catch (e: ActivityNotFoundException) {
                    chooserCallback?.onReceiveValue(null)
                    chooserCallback = null
                    toast(R.string.geen_app)
                }
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny() // geen camera, microfoon e.d.
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, false, false)
            }
        }
    }

    private fun configureServiceWorkers() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) return
        val sw = ServiceWorkerControllerCompat.getInstance().serviceWorkerWebSettings
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_CONTENT_ACCESS)) sw.allowContentAccess = false
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_FILE_ACCESS)) sw.allowFileAccess = false
    }

    private fun installBridge() {
        bridgeSupported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        binarySupported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        if (!bridgeSupported) {
            toast(R.string.webview_te_oud)
            return
        }
        // Het object PdfReaderAndroid bestaat alleen in pagina's van https://bruindav.github.io.
        WebViewCompat.addWebMessageListener(webView, BRIDGE_NAME, setOf(ORIGIN)) { view, message, sourceOrigin, isMainFrame, proxy ->
            if (!isMainFrame) return@addWebMessageListener
            if (sourceOrigin.scheme != "https" || sourceOrigin.host != HOST || (sourceOrigin.port != -1 && sourceOrigin.port != 443)) {
                return@addWebMessageListener
            }
            val current = view.url?.let { Uri.parse(it) }
            if (current == null || !isAppUrl(current)) return@addWebMessageListener
            onWebMessage(message, proxy)
        }
    }

    // ---------------------------------------------------------------- navigatie

    private fun isAppUrl(url: Uri): Boolean {
        if (url.scheme != "https" || url.host != HOST) return false
        if (url.port != -1 && url.port != 443) return false
        val path = url.path ?: return false
        return path == "/PdfReader" || path.startsWith(PATH_PREFIX)
    }

    private fun openExternal(url: Uri) {
        val scheme = url.scheme?.lowercase() ?: return
        if (scheme !in setOf("https", "http", "mailto", "tel")) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            toast(R.string.geen_app)
        }
    }

    // ---------------------------------------------------------------- PDF's van buiten

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val uri: Uri? = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND ->
                IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                    ?: intent.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
            else -> null
        }
        if (uri != null) deliverOrQueue(uri)
    }

    private fun onOpenDocumentResult(uri: Uri?) {
        val cb = chooserCallback
        chooserCallback = null
        if (cb != null) {
            cb.onReceiveValue(uri?.let { arrayOf(it) })
            return
        }
        if (uri != null) deliverOrQueue(uri)
    }

    /** Bewaart het bestand tot de web-app "ready" heeft gemeld (koude start), of stuurt het direct. */
    private fun deliverOrQueue(uri: Uri) {
        pendingUri = uri
        flushPending()
    }

    private fun flushPending() {
        val proxy = replyProxy ?: return
        val uri = pendingUri ?: return
        pendingUri = null
        val id = fileIds.getAndIncrement()
        io.execute { readAndSend(uri, id, proxy) }
    }

    private class Meta(val name: String, val size: Long)

    private fun queryMeta(uri: Uri): Meta {
        var name = ""
        var size = -1L
        if (uri.scheme == "file") {
            val f = File(uri.path ?: "")
            name = f.name
            size = f.length()
        } else {
            try {
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val si = c.getColumnIndex(OpenableColumns.SIZE)
                        if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni) ?: ""
                        if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                    }
                }
            } catch (e: Exception) {
                // Sommige apps ondersteunen geen query; naam en grootte blijven dan onbekend.
            }
        }
        if (name.isBlank()) name = uri.lastPathSegment?.substringAfterLast('/') ?: ""
        name = name.replace(Regex("[\\u0000-\\u001f]"), "").take(200)
        if (name.isBlank()) name = "document.pdf"
        return Meta(name, size)
    }

    /** file://-adressen: nooit bestanden uit de eigen app-map of systeemmappen doorgeven. */
    private fun isAllowedFileUri(uri: Uri): Boolean {
        val path = uri.path ?: return false
        return try {
            val f = File(path).canonicalFile
            val own = File(applicationInfo.dataDir).canonicalPath
            val p = f.path
            f.isFile && !p.startsWith("$own/") && !p.startsWith("/proc/") && !p.startsWith("/sys/") &&
                !p.startsWith("/data/data/") && !p.startsWith("/data/user/")
        } catch (e: IOException) {
            false
        }
    }

    /** Draait op de achtergrondthread: leest het bestand in stukken en stuurt die naar de web-app. */
    private fun readAndSend(uri: Uri, id: Int, proxy: JavaScriptReplyProxy) {
        fun fail(code: String) = onMain { postJson(proxy, JSONObject().put("type", "file-error").put("id", id).put("code", code)) }
        try {
            when (uri.scheme) {
                "content" -> Unit
                "file" -> if (!isAllowedFileUri(uri)) { fail("missing"); return }
                else -> { fail("unknown"); return }
            }
            val meta = queryMeta(uri)
            if (meta.size > MAX_BYTES) { fail("too-big"); return }
            val input: InputStream = contentResolver.openInputStream(uri) ?: run { fail("missing"); return }
            input.use { ins ->
                onMain {
                    postJson(proxy, JSONObject().put("type", "file-begin").put("id", id).put("name", meta.name).put("size", meta.size))
                }
                val buf = ByteArray(CHUNK)
                var total = 0L
                while (true) {
                    val n = readFully(ins, buf)
                    if (n <= 0) break
                    total += n
                    if (total > MAX_BYTES) { fail("too-big"); return }
                    val chunk = buf.copyOf(n)
                    onMain { postBytes(proxy, id, chunk) }
                    if (n < buf.size) break
                }
                onMain { postJson(proxy, JSONObject().put("type", "file-end").put("id", id)) }
            }
        } catch (e: SecurityException) {
            fail("missing")
        } catch (e: FileNotFoundException) {
            fail("missing")
        } catch (e: OutOfMemoryError) {
            fail("too-big")
        } catch (e: Exception) {
            fail("unknown")
        }
    }

    private fun readFully(ins: InputStream, buf: ByteArray): Int {
        var off = 0
        while (off < buf.size) {
            val r = ins.read(buf, off, buf.size - off)
            if (r < 0) break
            off += r
        }
        return off
    }

    /** Voert [block] uit op de hoofdthread en wacht (tegendruk voor grote bestanden). */
    private fun onMain(block: () -> Unit) {
        val latch = CountDownLatch(1)
        mainHandler.post {
            try {
                if (!isDestroyed) block()
            } catch (e: Exception) {
                // Pagina weg of brug verbroken: dit bericht vervalt.
            } finally {
                latch.countDown()
            }
        }
        latch.await(30, TimeUnit.SECONDS)
    }

    private fun postJson(proxy: JavaScriptReplyProxy, obj: JSONObject) {
        proxy.postMessage(obj.toString())
    }

    @SuppressLint("RequiresFeature")
    private fun postBytes(proxy: JavaScriptReplyProxy, id: Int, bytes: ByteArray) {
        if (binarySupported) {
            proxy.postMessage(bytes)
        } else {
            postJson(proxy, JSONObject().put("type", "file-chunk").put("id", id).put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP)))
        }
    }

    // ---------------------------------------------------------------- berichten van de web-app

    @SuppressLint("RequiresFeature")
    private fun onWebMessage(message: WebMessageCompat, proxy: JavaScriptReplyProxy) {
        if (binarySupported && message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
            onSaveBytes(message.arrayBuffer)
            return
        }
        val data = message.data ?: return
        val msg = try { JSONObject(data) } catch (e: Exception) { return }
        when (msg.optString("type")) {
            "ready" -> {
                replyProxy = proxy
                abortUpload()
                postJson(proxy, JSONObject().put("type", "hello").put("v", 1).put("binary", binarySupported))
                flushPending()
            }
            "save-begin" -> onSaveBegin(msg, proxy)
            "save-chunk" -> {
                val up = upload ?: return
                if (msg.optInt("id", -1) != up.id) return
                val bytes = try { Base64.decode(msg.optString("b64"), Base64.DEFAULT) } catch (e: IllegalArgumentException) { up.failed = true; return }
                onSaveBytes(bytes)
            }
            "save-end" -> {
                val up = upload ?: return
                if (msg.optInt("id", -1) != up.id) return
                upload = null
                io.execute {
                    closeQuietly(up)
                    mainHandler.post { finishUpload(up) }
                }
            }
        }
    }

    private fun onSaveBegin(msg: JSONObject, proxy: JavaScriptReplyProxy) {
        replyProxy = proxy
        abortUpload()
        val id = msg.optInt("id", -1)
        if (id < 0) return
        val action = msg.optString("action")
        val size = msg.optLong("size", -1)
        if (action != "save" && action != "share") { replySave(id, "error"); return }
        if (size > MAX_BYTES) { replySave(id, "too-big"); return }
        val name = safePdfName(msg.optString("name"))
        try {
            val dir = File(cacheDir, if (action == "share") "delen/$id" else "opslaan").apply { mkdirs() }
            val file = if (action == "share") File(dir, name) else File.createTempFile("upload-", ".pdf", dir)
            upload = Upload(id, name, action, file, FileOutputStream(file))
        } catch (e: IOException) {
            replySave(id, "error")
        }
    }

    private fun onSaveBytes(bytes: ByteArray) {
        val up = upload ?: return
        up.written += bytes.size
        if (up.written > MAX_BYTES) { up.tooBig = true; return }
        if (up.failed || up.tooBig) return
        io.execute {
            if (up.failed || up.tooBig) return@execute
            try {
                up.out.write(bytes)
            } catch (e: IOException) {
                up.failed = true
            }
        }
    }

    private fun finishUpload(up: Upload) {
        if (up.failed || up.tooBig) {
            up.file.delete()
            replySave(up.id, if (up.tooBig) "too-big" else "error")
            return
        }
        when (up.action) {
            "save" -> {
                awaitingSave?.let { old -> old.file.delete(); replySave(old.id, "cancelled") }
                awaitingSave = up
                try {
                    createDocument.launch(up.name)
                } catch (e: ActivityNotFoundException) {
                    awaitingSave = null
                    up.file.delete()
                    replySave(up.id, "error")
                }
            }
            "share" -> {
                try {
                    val uri = FileProvider.getUriForFile(this, "$packageName.files", up.file)
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = PDF_MIME
                        putExtra(Intent.EXTRA_STREAM, uri)
                        clipData = ClipData.newRawUri(up.name, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivity(Intent.createChooser(send, getString(R.string.delen_titel)))
                    replySave(up.id, "shared")
                } catch (e: Exception) {
                    up.file.delete()
                    replySave(up.id, "error")
                }
            }
        }
    }

    private fun onCreateDocumentResult(uri: Uri?) {
        val up = awaitingSave ?: return
        awaitingSave = null
        if (uri == null) {
            up.file.delete()
            replySave(up.id, "cancelled")
            return
        }
        io.execute {
            val ok = try {
                contentResolver.openOutputStream(uri, "w")?.use { out ->
                    up.file.inputStream().use { it.copyTo(out, CHUNK) }
                    true
                } ?: false
            } catch (e: Exception) {
                false
            }
            up.file.delete()
            mainHandler.post { replySave(up.id, if (ok) "saved" else "error") }
        }
    }

    private fun replySave(id: Int, status: String) {
        val proxy = replyProxy ?: return
        try {
            postJson(proxy, JSONObject().put("type", "save-result").put("id", id).put("status", status))
        } catch (e: Exception) {
            // pagina is weg
        }
        if (status == "error") toast(R.string.opgeslagen_fout)
    }

    private fun abortUpload() {
        val up = upload ?: return
        upload = null
        io.execute {
            closeQuietly(up)
            up.file.delete()
        }
    }

    private fun closeQuietly(up: Upload) {
        try { up.out.close() } catch (e: IOException) { up.failed = true }
    }

    private fun safePdfName(raw: String): String {
        var base = raw.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "-").trim().trim('.')
        if (base.lowercase().endsWith(".pdf")) base = base.dropLast(4)
        base = base.take(180).trim()
        if (base.isEmpty()) base = "document"
        return "$base.pdf"
    }

    private fun cleanTempDirs() {
        // Oude tijdelijke bestanden van een vorige sessie opruimen.
        io.execute {
            File(cacheDir, "opslaan").deleteRecursively()
            File(cacheDir, "delen").deleteRecursively()
        }
    }

    private fun toast(res: Int) {
        Toast.makeText(this, res, Toast.LENGTH_LONG).show()
    }
}
