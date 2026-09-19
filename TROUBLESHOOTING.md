# Troubleshooting Guide

## Common Issues & Solutions

### 1. Issue: Enter key doesn't submit prompt
* **Solution**: Ensure focus is in the prompt textarea. Pressing `Enter` without `Shift` triggers prompt submission. `Shift + Enter` inserts a newline.

### 2. Issue: Screenshot paste doesn't show thumbnail
* **Solution**: Verify that the clipboard contains image data (`image/png` or `image/jpeg`). Also ensure image size is under 10MB.

### 3. Issue: General knowledge questions scan code files
* **Solution**: Ensure prompt is conversational (e.g., "who is roger federer?", "hello"). The router classifies general knowledge queries under `GENERAL_QUERY` fast-path and bypasses AST workspace scanning.

### 4. Issue: Generated code files have incorrect syntax
* **Solution**: Clear browser cache and ensure file extension matches desired language (`.html`, `.css`, `.js`, `.py`, `.ts`).

### 5. Issue: Run Comprehensive Verification Check
* **Solution**: Type `@test comprehensive` or `@test all-features` into the prompt input bar to execute automated feature checkups.
