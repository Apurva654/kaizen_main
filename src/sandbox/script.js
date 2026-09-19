document.addEventListener('DOMContentLoaded', function () {
    const display = document.getElementById('display');
    const buttons = document.querySelectorAll('.calc-button');
    const clearBtn = document.getElementById('clear');
    const equalsBtn = document.getElementById('equals');

    // Append value to display
    function appendToDisplay(value) {
        display.value += value;
    }

    // Clear display
    function clearDisplay() {
        display.value = '';
    }

    // Evaluate expression safely
    function evaluateExpression() {
        const expr = display.value;
        if (!expr) return;
        try {
            // Replace any accidental multiple operators (basic sanitization)
            const sanitized = expr.replace(/[^-+*/0-9.]/g, '');
            // Use Function constructor for evaluation; it's limited to arithmetic here
            const result = Function('"use strict";return (' + sanitized + ')')();
            display.value = Number.isFinite(result) ? result : 'Error';
        } catch (e) {
            display.value = 'Error';
        }
    }

    buttons.forEach(btn => {
        const value = btn.getAttribute('data-value');
        if (!value) return; // Skip clear and equals which have no data-value
        btn.addEventListener('click', () => appendToDisplay(value));
    });

    clearBtn.addEventListener('click', clearDisplay);
    equalsBtn.addEventListener('click', evaluateExpression);
});