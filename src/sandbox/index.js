// index.js – Simple Node entry point that verifies the presence of the HTML file
const fs = require('fs');
const path = require('path');

function checkSiteFiles() {
  const htmlPath = path.join(__dirname, 'index.html');
  try {
    const content = fs.readFileSync(htmlPath, 'utf8');
    console.log('Travel site HTML file found. Length:', content.length, 'characters');
  } catch (err) {
    console.error('Error reading index.html:', err.message);
  }
}

// Execute when run directly
if (require.main === module) {
  checkSiteFiles();
}

module.exports = { checkSiteFiles };