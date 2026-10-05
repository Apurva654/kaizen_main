// script.js – Handles interactive behavior for the Travel Explorer site

// Form submission handling
document.addEventListener('DOMContentLoaded', function () {
  const form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const name = form.elements['name'].value.trim();
      const email = form.elements['email'].value.trim();
      if (name && email) {
        alert(`Thank you, ${name}! We will contact you at ${email}.`);
        form.reset();
      } else {
        alert('Please fill out both name and email fields.');
      }
    });
  }
});

// Demo block – runs when script.js is executed directly with Node (non‑browser environment)
if (typeof require !== 'undefined' && require.main === module) {
  console.log('script.js loaded – interactive features are ready when used in a browser.');
}