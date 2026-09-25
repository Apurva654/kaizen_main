export interface ParsedFormField {
  label: string;
  name: string;
  type: string;
  placeholder?: string;
  required: boolean;
  value?: string;
  ref?: string;
}

export interface ParsedControl {
  type: string;
  name: string;
  ref?: string;
}

export interface RequestedBrowserAction {
  action: 'click' | 'type' | 'fill' | 'press' | 'select' | 'hover';
  target: string;
  text?: string;
}

export interface TargetResolutionResult {
  found: boolean;
  elementRef?: string;
  targetName?: string;
  elementType?: string;
  availableCandidates?: string[];
  error?: string;
}

export interface StructuredBrowserInspection {
  url: string;
  title: string;
  headings: string[];
  controls: ParsedControl[];
  formFields: ParsedFormField[];
  consoleErrors: string[];
  mcpToolsExecuted: string[];
  rawSnapshot: string;
  actionExecuted?: {
    action: string;
    target: string;
    elementRef?: string;
    success: boolean;
    error?: string;
  };
}

/**
 * Parses raw Playwright accessibility snapshots and metadata into structured Generative UI model
 */
export function parseBrowserInspectionResult(
  rawSnapshot: string,
  url: string,
  toolsExecuted: string[] = ['browser_navigate', 'browser_snapshot'],
  consoleLogs: string[] = []
): StructuredBrowserInspection {
  const headings: string[] = [];
  const controls: ParsedControl[] = [];
  const formFields: ParsedFormField[] = [];
  const consoleErrors: string[] = [];
  let pageTitle = '';

  // Add initial passed-in console log errors
  if (Array.isArray(consoleLogs)) {
    for (const err of consoleLogs) {
      if (err && typeof err === 'string' && err.trim()) {
        consoleErrors.push(err.trim());
      }
    }
  }

  let reportedErrorHeaderCount = 0;
  let reportedHeaderStr = '';

  const lines = rawSnapshot.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect meta summary header lines like "Console: 2 errors, 0 warnings" or "Console: 1 error"
    const summaryMatch = trimmed.match(/^console:\s*(\d+)\s*errors?/i) || trimmed.match(/^console\s*errors?\s*\(\s*(\d+)\s*\)/i);
    if (summaryMatch) {
      reportedErrorHeaderCount = parseInt(summaryMatch[1], 10);
      reportedHeaderStr = trimmed;
      continue;
    }

    // Detect Console Errors in snapshot or output
    if (/console\s*error|uncaught\s*error|failed\s*to\s*load|404\s*\(not\s*found\)|500\s*\(internal\s*server\s*error\)|typeerror:|referenceerror:|syntaxerror:|\[error\]|error\s*\(/i.test(trimmed)) {
      if (!consoleErrors.includes(trimmed)) {
        consoleErrors.push(trimmed);
      }
      continue;
    }

    // Extract Page Title
    const titleMatch = trimmed.match(/^title[:\s]+"(.*?)"$/i) || trimmed.match(/page\s+title[:\s]+"(.*?)"$/i);
    if (titleMatch && titleMatch[1]) {
      pageTitle = titleMatch[1];
      continue;
    }

    // Extract Headings (heading [ref=eX] "Heading Text")
    const headingMatch = trimmed.match(/heading\s*(?:\[ref=([\w\d]+)\])?\s*"(.*?)"/i) || trimmed.match(/h[1-6]\s*"(.*?)"/i);
    if (headingMatch) {
      const headingText = headingMatch[2] || headingMatch[1];
      if (headingText && !headings.includes(headingText)) {
        headings.push(headingText);
        if (!pageTitle && headings.length === 1) {
          pageTitle = headingText;
        }
      }
      continue;
    }

    // Extract Form Fields (textbox, input, password, checkbox, radio, select, combobox)
    const formMatch = trimmed.match(/(textbox|password|input|checkbox|radio|combobox|listbox|searchbox)\s*(?:\[ref=([\w\d]+)\])?(?:\s*"([^"]*)")?/i);
    if (formMatch) {
      const fieldType = formMatch[1].toLowerCase();
      const ref = formMatch[2] || '';
      const label = formMatch[3] || fieldType;

      const isRequired = /\b(required)\b/i.test(trimmed);
      const placeholderMatch = trimmed.match(/placeholder="([^"]+)"/i);
      const valueMatch = trimmed.match(/value="([^"]+)"/i);

      formFields.push({
        label,
        name: label.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        type: fieldType,
        placeholder: placeholderMatch ? placeholderMatch[1] : undefined,
        required: isRequired,
        value: valueMatch ? valueMatch[1] : undefined,
        ref
      });
      continue;
    }

    // Extract Interactive Controls (button, link, menuitem, tab)
    const controlMatch = trimmed.match(/(button|link|menuitem|tab)\s*(?:\[ref=([\w\d]+)\])?\s*"([^"]+)"/i);
    if (controlMatch) {
      const cType = controlMatch[1].toLowerCase();
      const ref = controlMatch[2] || '';
      const name = controlMatch[3];
      if (name && name.length < 60) {
        controls.push({ type: cType, name, ref });
      }
    }
  }

  // Fallback title from URL if empty
  if (!pageTitle) {
    try {
      const parsedUrl = new URL(url);
      pageTitle = `${parsedUrl.hostname}${parsedUrl.pathname}`;
    } catch {
      pageTitle = 'Web Inspection Page';
    }
  }

  if (consoleErrors.length === 0 && reportedErrorHeaderCount > 0) {
    consoleErrors.push(reportedHeaderStr || `Console: ${reportedErrorHeaderCount} error${reportedErrorHeaderCount === 1 ? '' : 's'}`);
  }

  return {
    url,
    title: pageTitle,
    headings: Array.from(new Set(headings)),
    controls: Array.from(new Set(controls.map(c => JSON.stringify(c)))).map(s => JSON.parse(s)),
    formFields: Array.from(new Set(formFields.map(f => JSON.stringify(f)))).map(s => JSON.parse(s)),
    consoleErrors,
    mcpToolsExecuted: toolsExecuted,
    rawSnapshot
  };
}

/**
 * Formats a StructuredBrowserInspection object into beautiful Markdown with Generative UI elements
 */
export function formatBrowserInspectionMarkdown(inspection: StructuredBrowserInspection): string {
  let md = `### 🌐 Browser Inspection: ${inspection.title}\n\n`;

  md += `> [!NOTE]\n`;
  md += `> **URL**: \`${inspection.url}\` | **Page Title**: "${inspection.title}"  \n`;
  md += `> **MCP Server**: External Playwright MCP (\`@playwright/mcp\` over \`StdioClientTransport\`)  \n`;
  md += `> **Tools Executed**: \`${inspection.mcpToolsExecuted.join('`, `')}\`  \n`;
  md += `> **Mode**: Read-Only Inspection (No workspace files created or modified)\n\n`;

  // Surface Console Errors
  if (inspection.consoleErrors.length > 0) {
    md += `> [!WARNING]\n`;
    md += `> **Console**: ${inspection.consoleErrors.length} error${inspection.consoleErrors.length === 1 ? '' : 's'}\n\n`;
    md += `<details><summary><b>View Console Error Messages (${inspection.consoleErrors.length})</b></summary>\n\n\`\`\`text\n`;
    md += inspection.consoleErrors.join('\n');
    md += `\n\`\`\`\n</details>\n\n`;
  } else {
    md += `**Console**: 0 errors\n\n`;
  }

  // Headings
  if (inspection.headings.length > 0) {
    md += `#### 📋 Key Page Headings\n`;
    for (const h of inspection.headings) {
      md += `- **${h}**\n`;
    }
    md += `\n`;
  }

  // Form Fields Table
  if (inspection.formFields.length > 0) {
    md += `#### 📝 Form Fields & Input Controls\n\n`;
    md += `| Field Label | Field Type | Placeholder | Required | Ref |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- |\n`;
    for (const field of inspection.formFields) {
      const ph = field.placeholder || '-';
      const req = field.required ? '✅ Required' : 'Optional';
      const ref = field.ref ? `\`${field.ref}\`` : '-';
      md += `| **${field.label}** | \`${field.type}\` | ${ph} | ${req} | ${ref} |\n`;
    }
    md += `\n`;
  }

  // Interactive Controls
  if (inspection.controls.length > 0) {
    md += `#### 🔘 Interactive UI Controls (${inspection.controls.length})\n\n`;
    for (const ctrl of inspection.controls.slice(0, 15)) {
      const badge = ctrl.type === 'button' ? '🔘 Button' : '🔗 Link';
      const refStr = ctrl.ref ? ` (\`${ctrl.ref}\`)` : '';
      md += `- ${badge}: **${ctrl.name}**${refStr}\n`;
    }
    if (inspection.controls.length > 15) {
      md += `\n*... and ${inspection.controls.length - 15} more controls.*\n`;
    }
    md += `\n`;
  }

  // Collapsible Raw Accessibility Snapshot
  md += `<details><summary><b>Raw Accessibility Snapshot</b></summary>\n\n\`\`\`yaml\n`;
  md += inspection.rawSnapshot;
  md += `\n\`\`\`\n</details>\n\n`;

  if (inspection.actionExecuted) {
    md += `\n> [!TIP]\n`;
    md += `> **Browser Action Executed**: \`${inspection.actionExecuted.action}\` on \`"${inspection.actionExecuted.target}"\` ${inspection.actionExecuted.elementRef ? `(ref: \`${inspection.actionExecuted.elementRef}\`)` : ''}  \n`;
    md += `> **Action Status**: ${inspection.actionExecuted.success ? '✅ Success' : `❌ Failed: ${inspection.actionExecuted.error}`}\n`;
  }

  return md.trim();
}

/**
 * Parses explicit user intent for interactive browser actions (click, type, fill, press, select, hover)
 */
export function extractRequestedBrowserAction(prompt: string): RequestedBrowserAction | null {
  if (!prompt || typeof prompt !== 'string') return null;

  // 1. Click action pattern: "click [the] ['"]?Target['"]? [button|link|element|tab]"
  const clickMatch = prompt.match(/\bclick\s+(?:the\s+)?['"]([^'"]+)['"](?:\s*(?:button|link|tab|element|control))?/i) ||
                     prompt.match(/\bclick\s+(?:the\s+)?([\w\s-]+?)(?:\s+(?:button|link|tab|element|control))?(?:\s+and\s+|\s+to\s+|\.|\s*$)/i);
  if (clickMatch) {
    const rawTarget = clickMatch[1].trim();
    if (rawTarget && rawTarget.length > 0 && rawTarget.length < 50 && !/^(the|a|an|page|url|http)/i.test(rawTarget)) {
      return { action: 'click', target: rawTarget };
    }
  }

  // 2. Type / Fill action pattern: "type 'text' into 'target'" or "fill 'target' with 'text'"
  const typeMatch = prompt.match(/\b(?:type|enter)\s+['"]?([^'"]+?)['"]?\s+into\s+['"]?([^'"]+?)['"]?(?:\.|\s|$)/i) ||
                    prompt.match(/\bfill\s+['"]?([^'"]+?)['"]?\s+with\s+['"]?([^'"]+?)['"]?(?:\.|\s|$)/i);
  if (typeMatch) {
    return {
      action: 'type',
      text: typeMatch[1].trim(),
      target: typeMatch[2].trim()
    };
  }

  // 3. Hover pattern: "hover [over] ['"]?Target['"]?"
  const hoverMatch = prompt.match(/\bhover\s+(?:over\s+)?['"]?([^'"]+?)['"]?(?:\.|\s|$)/i);
  if (hoverMatch && hoverMatch[1].length < 50) {
    return { action: 'hover', target: hoverMatch[1].trim() };
  }

  return null;
}

/**
 * Resolves requested target against accessibility tree parsed controls and form fields
 */
export function resolveAccessibilityTarget(
  targetText: string,
  inspection: StructuredBrowserInspection
): TargetResolutionResult {
  if (!targetText) {
    return { found: false, error: 'Target name is empty' };
  }

  const cleanTarget = targetText.trim().toLowerCase();

  // 1. Exact match on control names
  const exactControl = inspection.controls.find(c => c.name.trim().toLowerCase() === cleanTarget);
  if (exactControl) {
    return {
      found: true,
      elementRef: exactControl.ref,
      targetName: exactControl.name,
      elementType: exactControl.type
    };
  }

  // 2. Substring match on control names
  const subControl = inspection.controls.find(c => c.name.trim().toLowerCase().includes(cleanTarget) || cleanTarget.includes(c.name.trim().toLowerCase()));
  if (subControl) {
    return {
      found: true,
      elementRef: subControl.ref,
      targetName: subControl.name,
      elementType: subControl.type
    };
  }

  // 3. Match on form fields
  const exactField = inspection.formFields.find(f => f.label.trim().toLowerCase() === cleanTarget || f.name.trim().toLowerCase() === cleanTarget);
  if (exactField) {
    return {
      found: true,
      elementRef: exactField.ref,
      targetName: exactField.label,
      elementType: exactField.type
    };
  }

  const subField = inspection.formFields.find(f => f.label.trim().toLowerCase().includes(cleanTarget) || cleanTarget.includes(f.label.trim().toLowerCase()));
  if (subField) {
    return {
      found: true,
      elementRef: subField.ref,
      targetName: subField.label,
      elementType: subField.type
    };
  }

  // 4. Fallback: Not Found
  const availableCandidates = [
    ...inspection.controls.map(c => `"${c.name}" (${c.type})`),
    ...inspection.formFields.map(f => `"${f.label}" (${f.type})`)
  ].slice(0, 5);

  return {
    found: false,
    availableCandidates,
    error: `Requested browser target was not found: "${targetText}". ${availableCandidates.length > 0 ? `Available controls: ${availableCandidates.join(', ')}` : 'No interactive controls found on page.'}`
  };
}
