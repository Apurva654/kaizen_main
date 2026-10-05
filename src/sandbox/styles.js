// styles.js – Exports a helper that logs a message about CSS availability
function logStylesInfo() {
  console.log('styles.css is linked in index.html and provides the visual layout for the travel site.');
}

// Demo execution block
if (require.main === module) {
  logStylesInfo();
}

module.exports = { logStylesInfo };