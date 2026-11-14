/* fix-1 */
/* Wordt alleen geladen door oude browsers zonder ES-module-ondersteuning. */
(function () {
  var p = document.createElement('p');
  p.className = 'noscript';
  p.appendChild(document.createTextNode('Deze browser wordt niet ondersteund. Gebruik een recente versie van Chrome, Edge, Firefox of Safari.'));
  var main = document.getElementById('lezer');
  if (main) { main.innerHTML = ''; main.appendChild(p); }
})();
