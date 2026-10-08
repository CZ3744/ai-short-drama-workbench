export function plainTextToHtml(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      if (!trimmed) return "<p><br></p>";
      if (trimmed.startsWith("### ")) return `<h3>${trimmed.slice(4)}</h3>`;
      if (trimmed.startsWith("## ")) return `<h2>${trimmed.slice(3)}</h2>`;
      if (trimmed.startsWith("# ")) return `<h1>${trimmed.slice(2)}</h1>`;
      let html = trimmed
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/@([一-鿿\w]+)/g, '<span data-type="mention" data-id="$1">@$1</span>');
      return `<p>${html}</p>`;
    })
    .join("");
}

export function htmlToPlainText(html: string): string {
  return html
                        .replace(/<h1[^>]*>(.*?)<\/h1>/gs, (_, t) => `# ${t}\n`)
                        .replace(/<h2[^>]*>(.*?)<\/h2>/gs, (_, t) => `## ${t}\n`)
                        .replace(/<h3[^>]*>(.*?)<\/h3>/gs, (_, t) => `### ${t}\n`)
                        .replace(/<div[^>]*data-type="dialogue"[^>]*>.*?<span[^>]*class="[^"]*character[^"]*"[^>]*>(.*?)<\/span>.*?<span[^>]*class="[^"]*text[^"]*"[^>]*>(.*?)<\/span>.*?<\/div>/gs, "$1: $2")
                        .replace(/<div[^>]*data-type="voiceover"[^>]*>(.*?)<\/div>/gs, "$1")
                        .replace(/<div[^>]*data-type="stage_direction"[^>]*>(.*?)<\/div>/gs, "[$1]")
                        .replace(/<strong>(.*?)<\/strong>/g, "**$1**")
                        .replace(/<em>(.*?)<\/em>/g, "*$1*")
                        .replace(/<p>(?:\s*<br[^>]*>\s*)?<\/p>/g, "\n")
                        .replace(/<p>(.*?)<\/p>/gs, "$1\n")
                        .replace(/<[^>]+>/g, "")
                        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
                        .trim();
}
