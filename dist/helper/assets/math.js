/** Browser-side bridge to the vendored KaTeX bundle: typesets the `.md-math`
 * placeholders markdown.js emits, importing the bundle on first use. Until it
 * lands — and if it never does — a placeholder keeps showing its TeX source,
 * so the transcript always reads. */

let loading
let vendor

async function vendorModule() {
  loading ??= import('./vendor/katex.js').then((module) => {
    vendor = module
    return module
  }, () => {
    // The bundle failed to load; formulas stay as their TeX source.
    loading = undefined
    return undefined
  })
  return loading
}

/** Typeset every formula in `root` that has no rendered output yet. */
export async function typesetMath(root) {
  if (root === null || typeof root.querySelectorAll !== 'function') return
  const module = await vendorModule()
  if (module === undefined) return
  for (const node of root.querySelectorAll('.md-math:not([data-math-rendered])')) {
    const html = module.renderTexToHtml(node.textContent ?? '', node.dataset.mathDisplay === 'true')
    // The root may have been re-rendered while the bundle was loading.
    if (!node.isConnected) continue
    const template = document.createElement('template')
    // The HTML fragment parser is what puts KaTeX's MathML into the MathML
    // namespace; `createElement` would leave it in the HTML one.
    template.innerHTML = html
    node.replaceChildren(...template.content.childNodes)
    node.setAttribute('data-math-rendered', 'true')
  }
}

// A first formula should not flash as source, and the ball window is idle when
// it appears: warm the bundle up now rather than on the first settle.
const warmup = setTimeout(() => { void vendorModule() }, 0)
if (typeof warmup?.unref === 'function') warmup.unref()
