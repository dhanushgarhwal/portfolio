// Admin guard: no browser context menu anywhere (any element, inputs and dialogs included). Loaded first by app.js.
const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
addEventListener("contextmenu", stop, { capture: true });
addEventListener("auxclick", (e) => { if (e.button === 2) stop(e); }, { capture: true });
addEventListener("mousedown", (e) => { if (e.button === 2) stop(e); }, { capture: true });
addEventListener("dragstart", (e) => { if (!(e.target instanceof Element) || !e.target.closest(".rich")) e.preventDefault(); }, { capture: true });
