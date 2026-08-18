/**
 * Stands in for a stylesheet or an image import under the test runner.
 *
 * Vite turns `import "./x.css"` into a side effect and `import logo from
 * "./a.png"` into a URL string. Node would try to parse both as JavaScript, so
 * `test/jsx-hooks.mjs` points them here instead. The default export is the empty
 * string because an image import is used as a `src`, and `undefined` there
 * renders as the literal text "undefined".
 */
export default "";
