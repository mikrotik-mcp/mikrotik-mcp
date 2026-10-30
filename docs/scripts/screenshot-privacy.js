// Capture-only DOM masking; never change the dashboard's stored data.
export function maskDocumentationScreenshot(names = [], usernames = []) {
  const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  const ipv6 = /[\da-f]*:[\da-f:.]+(?:%[\w.-]+)?/gi;
  const sensitiveNames = [
    ...new Set(names.filter((name) => typeof name === "string" && name.trim())),
  ].sort((a, b) => b.length - a.length);
  const privateUsers = [
    ...new Set(usernames.filter((name) => typeof name === "string" && name.trim())),
  ];
  const wordCharacter = /[\p{L}\p{N}_]/u;
  function ranges(text) {
    const found = [...text.matchAll(ipv4)].map((match) => [
      match.index,
      match.index + match[0].length,
    ]);
    for (const match of text.matchAll(/\b(?:\d{1,3}\.){2}\d{0,3}(?:\.{2,}|…)/g))
      found.push([match.index, match.index + match[0].length]);
    for (const match of text.matchAll(/[\da-f]{1,4}:[\da-f:.]+(?:\.{2,}|…)/gi)) {
      if ((match[0].match(/:/g) ?? []).length >= 2)
        found.push([match.index, match.index + match[0].length]);
    }
    for (const match of text.matchAll(ipv6)) {
      if (match[0].includes("::") || (match[0].match(/:/g) ?? []).length >= 7)
        found.push([match.index, match.index + match[0].length]);
    }
    for (const name of sensitiveNames) {
      let at = text.indexOf(name);
      while (at >= 0) {
        found.push([at, at + name.length]);
        at = text.indexOf(name, at + name.length);
      }
    }
    for (const username of privateUsers) {
      let at = text.indexOf(username);
      while (at >= 0) {
        const end = at + username.length;
        if (!wordCharacter.test(text[at - 1] ?? "") && !wordCharacter.test(text[end] ?? ""))
          found.push([at, end]);
        at = text.indexOf(username, end);
      }
    }
    return found
      .sort((a, b) => a[0] - b[0])
      .reduce((merged, range) => {
        const previous = merged.at(-1);
        if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
        else merged.push(range);
        return merged;
      }, []);
  }
  function redact() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    for (const node of nodes) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest("[data-doc-private]") ||
        ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)
      )
        continue;
      const matches = ranges(node.textContent);
      if (!matches.length) continue;
      if (parent.closest("svg")) {
        parent.style.setProperty("filter", "blur(12px)", "important");
        parent.dataset.docPrivate = "true";
        continue;
      }
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const [start, end] of matches) {
        fragment.append(document.createTextNode(node.textContent.slice(offset, start)));
        const mask = document.createElement("span");
        mask.dataset.docPrivate = "true";
        mask.style.cssText =
          "display:inline-block;filter:blur(12px)!important;user-select:none!important";
        mask.textContent = node.textContent.slice(start, end);
        fragment.append(mask);
        offset = end;
      }
      fragment.append(document.createTextNode(node.textContent.slice(offset)));
      node.replaceWith(fragment);
    }
    document.querySelectorAll("input,textarea,select").forEach((control) => {
      if (ranges(control.value ?? "").length || ranges(control.placeholder ?? "").length)
        control.style.setProperty("filter", "blur(12px)", "important");
    });
    const view = document.querySelector("main")?.dataset.view;
    const nameColumn = view === "snapshots" ? 3 : ["backups", "s3"].includes(view) ? 1 : null;
    if (nameColumn)
      document.querySelectorAll(`main tbody tr td:nth-child(${nameColumn})`).forEach((cell) => {
        cell.style.setProperty("filter", "blur(12px)", "important");
        cell.dataset.docPrivate = "true";
      });
  }
  redact();
  new MutationObserver(redact).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return { masked: document.querySelectorAll("[data-doc-private]").length };
}
