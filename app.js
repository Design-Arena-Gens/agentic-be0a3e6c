(() => {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const scaleSelect = document.getElementById('scaleFactor');
  const upscaleBtn = document.getElementById('upscaleBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const statusEl = document.getElementById('status');
  const progressWrapper = document.getElementById('progressWrapper');
  const progressBar = document.getElementById('progressBar');
  const originalPreview = document.getElementById('originalPreview');
  const originalMeta = document.getElementById('originalMeta');
  const resultCanvas = document.getElementById('resultCanvas');
  const resultMeta = document.getElementById('resultMeta');

  let currentImage = null;
  let currentObjectUrl = null;
  let isProcessing = false;

  const worker = new Worker('worker.js');

  worker.onmessage = (event) => {
    const { type, payload } = event.data;
    switch (type) {
      case 'progress':
        updateProgress(payload.value, payload.label);
        break;
      case 'complete':
        handleComplete(payload);
        break;
      case 'error':
        handleError(payload.message);
        break;
      default:
        break;
    }
  };

  function resetProgress() {
    progressWrapper.hidden = true;
    progressBar.style.width = '0%';
    progressBar.dataset.label = '';
  }

  function updateProgress(value, label) {
    progressWrapper.hidden = false;
    const clamped = Math.min(100, Math.max(0, value));
    progressBar.style.width = `${clamped}%`;
    if (label) {
      statusEl.textContent = label;
    }
  }

  function setProcessingState(active) {
    isProcessing = active;
    upscaleBtn.disabled = !currentImage || active;
    downloadBtn.disabled = active;
    fileInput.disabled = active;
  }

  function revokeObjectUrl() {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  }

  function loadImage(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      handleError('Unsupported file type. Please choose an image.');
      return;
    }

    revokeObjectUrl();

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      currentImage = image;
      currentObjectUrl = objectUrl;
      originalPreview.src = objectUrl;
      originalPreview.style.display = 'block';
      originalMeta.textContent = `${image.naturalWidth} × ${image.naturalHeight}px`;
      resultMeta.textContent = '—';
      resultCanvas.width = 0;
      resultCanvas.height = 0;
      downloadBtn.disabled = true;
      upscaleBtn.disabled = false;
      statusEl.textContent = 'Ready to upscale.';
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      handleError('Could not load image.');
    };
    image.crossOrigin = 'anonymous';
    image.src = objectUrl;
  }

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) {
      loadImage(file);
    }
  });

  dropzone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    loadImage(file);
  });

  upscaleBtn.addEventListener('click', async () => {
    if (!currentImage || isProcessing) return;
    try {
      setProcessingState(true);
      resetProgress();
      statusEl.textContent = 'Preparing image…';

      const scale = parseInt(scaleSelect.value, 10);
      const width = currentImage.naturalWidth;
      const height = currentImage.naturalHeight;

      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(currentImage, 0, 0);

      const imageData = ctx.getImageData(0, 0, width, height);
      const bufferCopy = new Uint8ClampedArray(imageData.data).buffer;

      worker.postMessage(
        {
          type: 'process',
          payload: {
            width,
            height,
            scale,
            buffer: bufferCopy,
          },
        },
        [bufferCopy]
      );
    } catch (error) {
      handleError(error.message || 'Processing failed.');
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (!resultCanvas.width || !resultCanvas.height) return;
    resultCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'upscaled.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  });

  function handleComplete(payload) {
    const { width, height, buffer, duration } = payload;
    const resultContext = resultCanvas.getContext('2d');
    resultCanvas.width = width;
    resultCanvas.height = height;

    const resultData = new ImageData(new Uint8ClampedArray(buffer), width, height);
    resultContext.putImageData(resultData, 0, 0);

    resultMeta.textContent = `${width} × ${height}px • ${(duration / 1000).toFixed(2)}s`;
    statusEl.textContent = 'Enhancement complete.';
    downloadBtn.disabled = false;
    setProcessingState(false);
    resetProgress();
  }

  function handleError(message) {
    statusEl.textContent = message;
    setProcessingState(false);
    resetProgress();
  }

  window.addEventListener('beforeunload', () => {
    revokeObjectUrl();
    worker.terminate();
  });
})();
