import type { VisualizeInput } from "../src/index.ts";

/** A release timeline on the kit's steps, with saved state for the selected milestone. */
export const timeline: VisualizeInput = {
  title: "Visualizations rollout",
  html: String.raw`<style>
  .when { font: 11px/14px var(--pv-font-mono); color: var(--pv-text-subtle); }
  .pv-steps > li { cursor: pointer; }
  .pv-steps > li[aria-current="true"] .pv-step-title { text-decoration: underline; text-underline-offset: 3px; }
</style>
<ol class="pv-steps" id="steps"></ol>
<script>
  const MILESTONES = [
    { when: "Oct 28", title: "ADR 0101 accepted", body: "Zero-egress frame, sha256-pinned libraries.", state: "done" },
    { when: "Oct 30", title: "Frame package", body: "Validation, the document builder and the kit.", state: "current" },
    { when: "Nov 4", title: "Desktop and Mobile", body: "Inline frames, expand, theme updates." },
    { when: "Nov 11", title: "Release", body: "The Visuals setting ships, on rich by default." },
  ];
  const list = document.getElementById("steps");
  const saved = pv.state.get();
  MILESTONES.forEach((m, i) => {
    const li = document.createElement("li");
    if (m.state) li.dataset.state = m.state;
    li.tabIndex = 0;
    li.innerHTML = '<div class="when"></div><div class="pv-step-title"></div><div class="pv-step-detail"></div>';
    li.children[0].textContent = m.when;
    li.children[1].textContent = m.title;
    li.children[2].textContent = m.body;
    if (saved && saved.selected === i) li.setAttribute("aria-current", "true");
    li.addEventListener("click", () => {
      list.querySelectorAll("li").forEach((other) => other.removeAttribute("aria-current"));
      li.setAttribute("aria-current", "true");
      pv.state.set({ selected: i });
    });
    list.appendChild(li);
  });
</script>`,
};
