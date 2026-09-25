// Expense evidence viewer. Links marked data-evidence-view open their receipt
// image or PDF in a modal instead of downloading it. Without this script the
// same links open the file in the browser.
(function () {
  var dialog = document.getElementById('evidence-viewer');
  if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== 'function') return;

  var stage = dialog.querySelector('[data-viewer-stage]');
  var title = document.getElementById('evidence-viewer-title');
  var count = dialog.querySelector('[data-viewer-count]');
  var prev = dialog.querySelector('[data-viewer-prev]');
  var next = dialog.querySelector('[data-viewer-next]');
  var open = dialog.querySelector('[data-viewer-open]');
  var download = dialog.querySelector('[data-viewer-download]');
  var close = dialog.querySelector('[data-viewer-close]');
  var files = [];
  var index = 0;

  function show(position) {
    index = position;
    var link = files[index];
    var url = link.getAttribute('href');
    var name = link.getAttribute('data-evidence-name') || '';
    var downloadUrl = link.getAttribute('data-evidence-download');

    title.textContent = name;
    count.textContent = files.length > 1 ? index + 1 + ' of ' + files.length : '';
    prev.hidden = next.hidden = files.length < 2;
    prev.disabled = index === 0;
    next.disabled = index === files.length - 1;
    open.href = url;
    download.hidden = !downloadUrl;
    if (downloadUrl) download.href = downloadUrl;
    else download.removeAttribute('href');

    stage.classList.remove('is-zoomed');
    stage.replaceChildren();
    if (link.getAttribute('data-evidence-mime') === 'application/pdf') {
      var frame = document.createElement('iframe');
      frame.className = 'evidence-viewer-pdf';
      frame.title = name;
      frame.src = url;
      stage.append(frame);
    } else {
      var image = document.createElement('img');
      image.className = 'evidence-viewer-image';
      image.alt = name;
      image.src = url;
      image.title = 'Click to zoom';
      stage.append(image);
    }
  }

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target instanceof Element ? event.target.closest('[data-evidence-view]') : null;
    if (!link) return;
    event.preventDefault();
    // One entry per file: a thumbnail and its filename can both link to it.
    var group = link.getAttribute('data-evidence-group');
    var seen = {};
    files = Array.prototype.filter.call(document.querySelectorAll('[data-evidence-view]'), function (candidate) {
      var href = candidate.getAttribute('href');
      if (candidate.getAttribute('data-evidence-group') !== group || seen[href]) return false;
      seen[href] = true;
      return true;
    });
    var href = link.getAttribute('href');
    show(Math.max(0, files.findIndex(function (file) { return file.getAttribute('href') === href; })));
    if (!dialog.open) dialog.showModal();
  });

  prev.addEventListener('click', function () { if (index > 0) show(index - 1); });
  next.addEventListener('click', function () { if (index < files.length - 1) show(index + 1); });
  close.addEventListener('click', function () { dialog.close(); });

  stage.addEventListener('click', function (event) {
    if (event.target instanceof HTMLImageElement) stage.classList.toggle('is-zoomed');
  });

  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowLeft' && index > 0) show(index - 1);
    if (event.key === 'ArrowRight' && index < files.length - 1) show(index + 1);
  });

  // Unload the file so a closed viewer holds no PDF or image in memory.
  dialog.addEventListener('close', function () {
    stage.replaceChildren();
    files = [];
  });
})();
