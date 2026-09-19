// Verifies that the shared Markdown component renders LaTeX math via KaTeX.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../../src/web/shared/ui/Markdown.js";

function render(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }));
}

describe("Markdown", () => {
  it("renders inline math with the dollar syntax", () => {
    const output = render("Energy: $E=mc^2$ unitless");
    expect(output).toContain('class="katex"');
    expect(output).not.toContain("katex-display");
  });

  it("renders single-line $$…$$ as display math", () => {
    expect(render("$$\\frac{a}{b}$$")).toContain("katex-display");
  });

  it("renders fenced $$…$$ on its own lines as display math", () => {
    expect(render("$$\n\\frac{a}{b}\n$$")).toContain("katex-display");
  });

  it("leaves plain text without dollars untouched", () => {
    expect(render("Costs $5")).not.toContain("katex");
  });
});
