const LANCZOS_A = 3;

self.onmessage = async (event) => {
  const { type, payload } = event.data;
  if (type === 'process') {
    try {
      const { width, height, scale, buffer } = payload;
      const start = performance.now();
      const source = new Uint8ClampedArray(buffer);
      sendProgress(5, 'Running adaptive denoise…');

      const floats = toFloat32(source);
      const { y, cb, cr, alpha } = splitToYcbcr(floats, width, height);
      const denoisedY = bilateralFilterY(y, width, height, 1.25, 12);

      sendProgress(18, 'Preparing high-fidelity resampling…');
      const recombined = mergeFromYcbcr(denoisedY, cb, cr, alpha);

      const targetWidth = Math.round(width * scale);
      const targetHeight = Math.round(height * scale);

      const scaled = lanczosScaleRGBA(
        recombined,
        width,
        height,
        targetWidth,
        targetHeight,
        (progress) => sendProgress(18 + progress * 45, 'Performing progressive Lanczos scaling…')
      );

      sendProgress(68, 'Enhancing edges & micro-contrast…');
      const enhanced = enhanceLuma(scaled, targetWidth, targetHeight);

      sendProgress(88, 'Finalizing color & output…');
      const output = new Uint8ClampedArray(enhanced.length);
      for (let i = 0; i < enhanced.length; i += 4) {
        output[i] = clamp255(enhanced[i] + 0.5);
        output[i + 1] = clamp255(enhanced[i + 1] + 0.5);
        output[i + 2] = clamp255(enhanced[i + 2] + 0.5);
        output[i + 3] = clamp255(enhanced[i + 3] + 0.5);
      }

      const duration = performance.now() - start;
      sendProgress(100, 'Done.');
      self.postMessage(
        {
          type: 'complete',
          payload: {
            width: targetWidth,
            height: targetHeight,
            buffer: output.buffer,
            duration,
          },
        },
        [output.buffer]
      );
    } catch (error) {
      self.postMessage({
        type: 'error',
        payload: { message: error?.message || 'Processing failed.' },
      });
    }
  }
};

function sendProgress(value, label) {
  self.postMessage({
    type: 'progress',
    payload: { value, label },
  });
}

function toFloat32(src) {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = src[i];
  }
  return out;
}

function splitToYcbcr(rgba, width, height) {
  const size = width * height;
  const y = new Float32Array(size);
  const cb = new Float32Array(size);
  const cr = new Float32Array(size);
  const alpha = new Float32Array(size);
  for (let i = 0, p = 0; i < size; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const alphaValue = rgba[p + 3];
    const yy = 0.299 * r + 0.587 * g + 0.114 * b;
    const u = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    const v = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    y[i] = yy;
    cb[i] = u;
    cr[i] = v;
    alpha[i] = alphaValue;
  }
  return { y, cb, cr, alpha };
}

function mergeFromYcbcr(y, cb, cr, alpha) {
  const size = y.length;
  const out = new Float32Array(size * 4);
  for (let i = 0, p = 0; i < size; i++, p += 4) {
    const yy = y[i];
    const u = cb[i] - 128;
    const v = cr[i] - 128;
    let r = yy + 1.402 * v;
    let g = yy - 0.344136 * u - 0.714136 * v;
    let b = yy + 1.772 * u;
    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = alpha ? alpha[i] : 255;
  }
  return out;
}

function bilateralFilterY(src, width, height, sigmaSpatial, sigmaRange) {
  const out = new Float32Array(src.length);
  const spatialKernel = buildSpatialKernel3x3(sigmaSpatial);
  const sigmaRangeSq = 2 * sigmaRange * sigmaRange;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = src[idx];
      let sum = 0;
      let weightSum = 0;
      let k = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const ny = clamp(offsetY + y, 0, height - 1);
        for (let offsetX = -1; offsetX <= 1; offsetX++, k++) {
          const nx = clamp(offsetX + x, 0, width - 1);
          const neighborIdx = ny * width + nx;
          const neighbor = src[neighborIdx];
          const diff = neighbor - center;
          const rangeWeight = Math.exp(-(diff * diff) / sigmaRangeSq);
          const weight = spatialKernel[k] * rangeWeight;
          sum += neighbor * weight;
          weightSum += weight;
        }
      }
      out[idx] = weightSum > 0 ? sum / weightSum : center;
    }
  }
  return mixArrays(src, out, 0.35);
}

function buildSpatialKernel3x3(sigma) {
  const kernel = new Float32Array(9);
  const coords = [-1, 0, 1];
  const denom = 2 * sigma * sigma;
  let sum = 0;
  let i = 0;
  for (const y of coords) {
    for (const x of coords) {
      const distSq = x * x + y * y;
      const value = Math.exp(-distSq / denom);
      kernel[i++] = value;
      sum += value;
    }
  }
  for (let k = 0; k < kernel.length; k++) {
    kernel[k] /= sum;
  }
  return kernel;
}

function mixArrays(a, b, blend) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] * (1 - blend) + b[i] * blend;
  }
  return out;
}

function lanczosScaleRGBA(src, width, height, newWidth, newHeight, progressCallback) {
  const weightsX = precomputeWeights(width, newWidth, LANCZOS_A);
  const weightsY = precomputeWeights(height, newHeight, LANCZOS_A);
  const temp = new Float32Array(newWidth * height * 4);
  const dst = new Float32Array(newWidth * newHeight * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < newWidth; x++) {
      const list = weightsX[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < list.length; i++) {
        const { index, weight } = list[i];
        const srcIndex = (y * width + index) * 4;
        r += src[srcIndex] * weight;
        g += src[srcIndex + 1] * weight;
        b += src[srcIndex + 2] * weight;
        a += src[srcIndex + 3] * weight;
      }
      const dstIndex = (y * newWidth + x) * 4;
      temp[dstIndex] = r;
      temp[dstIndex + 1] = g;
      temp[dstIndex + 2] = b;
      temp[dstIndex + 3] = a;
    }
    if (progressCallback && y % 24 === 0) {
      progressCallback(y / height);
    }
  }

  for (let y = 0; y < newHeight; y++) {
    const listY = weightsY[y];
    for (let x = 0; x < newWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < listY.length; i++) {
        const { index, weight } = listY[i];
        const srcIndex = (index * newWidth + x) * 4;
        r += temp[srcIndex] * weight;
        g += temp[srcIndex + 1] * weight;
        b += temp[srcIndex + 2] * weight;
        a += temp[srcIndex + 3] * weight;
      }
      const dstIndex = (y * newWidth + x) * 4;
      dst[dstIndex] = r;
      dst[dstIndex + 1] = g;
      dst[dstIndex + 2] = b;
      dst[dstIndex + 3] = a;
    }
    if (progressCallback && y % 12 === 0) {
      progressCallback(0.5 + y / newHeight * 0.5);
    }
  }
  if (progressCallback) {
    progressCallback(1);
  }
  return dst;
}

function precomputeWeights(oldSize, newSize, a) {
  const weights = new Array(newSize);
  const scale = newSize / oldSize;
  const invScale = 1 / scale;
  const support = a;
  for (let i = 0; i < newSize; i++) {
    const center = (i + 0.5) * invScale;
    const left = Math.floor(center - support);
    const right = Math.ceil(center + support);
    const items = [];
    let sum = 0;
    for (let j = left; j <= right; j++) {
      if (j < 0 || j >= oldSize) continue;
      const x = center - j - 0.5;
      const weight = lanczosKernel(x, a);
      if (weight !== 0) {
        items.push({ index: j, weight });
        sum += weight;
      }
    }
    let normalized;
    if (items.length === 0) {
      const fallbackIndex = clamp(Math.round(center - 0.5), 0, oldSize - 1);
      normalized = [{ index: fallbackIndex, weight: 1 }];
    } else if (sum !== 0) {
      normalized = items.map(({ index, weight }) => ({
        index,
        weight: weight / sum,
      }));
    } else {
      const uniform = 1 / items.length;
      normalized = items.map(({ index }) => ({
        index,
        weight: uniform,
      }));
    }
    weights[i] = normalized;
  }
  return weights;
}

function lanczosKernel(x, a) {
  if (x === 0) return 1;
  const piX = Math.PI * x;
  const piXOverA = piX / a;
  return (Math.sin(piX) / piX) * (Math.sin(piXOverA) / piXOverA);
}

function enhanceLuma(rgba, width, height) {
  const size = width * height;
  const y = new Float32Array(size);
  const cb = new Float32Array(size);
  const cr = new Float32Array(size);
  for (let i = 0, p = 0; i < size; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const yy = 0.299 * r + 0.587 * g + 0.114 * b;
    const u = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    const v = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    y[i] = yy;
    cb[i] = u;
    cr[i] = v;
  }

  const blurred = gaussianBlur(y, width, height, 2, 1.2);
  const sharpened = new Float32Array(size);
  const threshold = 2.0;
  for (let i = 0; i < size; i++) {
    const original = y[i];
    const soft = blurred[i];
    const detail = original - soft;
    const magnitude = Math.abs(detail);
    const adaptiveBoost = magnitude > threshold ? 0.85 : 0.4;
    let value = original + adaptiveBoost * detail;
    value = value + 0.12 * (original - value); // protect colors
    sharpened[i] = value;
  }

  const normalized = contrastNormalize(sharpened, 0.05, 0.1);
  const out = new Float32Array(rgba.length);
  for (let i = 0, p = 0; i < size; i++, p += 4) {
    const yy = normalized[i];
    const u = cb[i] - 128;
    const v = cr[i] - 128;
    let r = yy + 1.402 * v;
    let g = yy - 0.344136 * u - 0.714136 * v;
    let b = yy + 1.772 * u;
    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = rgba[p + 3];
  }
  return out;
}

function gaussianBlur(data, width, height, radius, sigma) {
  const kernel = buildGaussianKernel(radius, sigma);
  const temp = new Float32Array(data.length);
  const out = new Float32Array(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let weightSum = 0;
      for (let k = -radius; k <= radius; k++) {
        const nx = clamp(x + k, 0, width - 1);
        const idx = y * width + nx;
        const weight = kernel[Math.abs(k)];
        sum += data[idx] * weight;
        weightSum += weight;
      }
      temp[y * width + x] = sum / weightSum;
    }
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let weightSum = 0;
      for (let k = -radius; k <= radius; k++) {
        const ny = clamp(y + k, 0, height - 1);
        const idx = ny * width + x;
        const weight = kernel[Math.abs(k)];
        sum += temp[idx] * weight;
        weightSum += weight;
      }
      out[y * width + x] = sum / weightSum;
    }
  }
  return out;
}

function buildGaussianKernel(radius, sigma) {
  const kernel = new Float32Array(radius + 1);
  const denom = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i <= radius; i++) {
    const value = Math.exp(-(i * i) / denom);
    kernel[i] = value;
    sum += i === 0 ? value : value * 2;
  }
  for (let i = 0; i <= radius; i++) {
    kernel[i] /= sum;
  }
  return kernel;
}

function contrastNormalize(data, lowClipRatio, strength) {
  const size = data.length;
  let mean = 0;
  for (let i = 0; i < size; i++) {
    mean += data[i];
  }
  mean /= size;

  let variance = 0;
  for (let i = 0; i < size; i++) {
    const diff = data[i] - mean;
    variance += diff * diff;
  }
  variance /= size;
  const std = Math.sqrt(Math.max(variance, 1e-5));

  const targetStd = Math.max(std, 28) * (1 + strength * 2.2);
  const adjusted = new Float32Array(size);
  const minRange = mean - targetStd;
  const maxRange = mean + targetStd;
  for (let i = 0; i < size; i++) {
    let value = data[i];
    const clipped = clamp(value, minRange, maxRange);
    value = mean + (clipped - mean) * (1 + strength);
    adjusted[i] = clamp(value, 0, 255);
  }

  if (lowClipRatio > 0) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < adjusted.length; i++) {
      const bucket = clamp(Math.round(adjusted[i]), 0, 255);
      histogram[bucket]++;
    }

    const total = adjusted.length;
    const lowerTarget = Math.floor(total * lowClipRatio);
    const upperTarget = Math.floor(total * (1 - lowClipRatio));

    let cumulative = 0;
    let low = 0;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative >= lowerTarget) {
        low = i;
        break;
      }
    }

    cumulative = 0;
    let high = 255;
    for (let i = 255; i >= 0; i--) {
      cumulative += histogram[i];
      if (cumulative >= total - upperTarget) {
        high = i;
        break;
      }
    }

    const range = high - low;
    const scale = range > 1 ? 255 / range : 1;
    for (let i = 0; i < adjusted.length; i++) {
      adjusted[i] = clamp((adjusted[i] - low) * scale, 0, 255);
    }
  }
  return adjusted;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function clamp255(value) {
  return Math.max(0, Math.min(255, value));
}
