const sharp = require('sharp');

// 닉네임 카드 좌표 — 1920x1080 스크린샷에서 카드 5개의 실제 경계를 픽셀 단위로 직접 측정해 도출.
// 카드1 왼쪽 시작 613px, 카드 반복 주기 211px, 카드 폭 191px (육안 확인: 카드 테두리 선 제외,
// 텍스트가 카드 안에서 가운데 정렬되도록 좌우 여백 조정 완료)
const CARD0_LEFT = 613 / 1920;
const CARD_PERIOD = 211 / 1920;
const CARD_WIDTH = 191 / 1920;
const T1_Y_MIN = 0.355, T1_Y_MAX = 0.385;
const T2_Y_MIN = 0.850, T2_Y_MAX = 0.882;

// DCT 기반 pHash: 32x32로 리사이즈 후 저주파 8x8(=64비트) 성분만 사용.
// 단순 8x8 평균해시는 이진화+축소 과정에서 글자 모양 정보가 거의 사라져
// 서로 다른 닉네임끼리 해시가 동일해지는 충돌이 실측에서 확인됨 (Hamming거리 0).
// DCT는 32x32 전체의 구조 정보를 주파수 성분으로 압축하므로 구분력이 훨씬 높다.
const DCT_SIZE = 32;
const HASH_BITS = 8; // 저주파 8x8 블록 사용 → 64비트

const COS_TABLE = (() => {
  const table = [];
  for (let k = 0; k < DCT_SIZE; k++) {
    const row = new Float64Array(DCT_SIZE);
    for (let n = 0; n < DCT_SIZE; n++) {
      row[n] = Math.cos((Math.PI / DCT_SIZE) * (n + 0.5) * k);
    }
    table.push(row);
  }
  return table;
})();

function dct1D(vec) {
  const N = vec.length;
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    const cosRow = COS_TABLE[k];
    for (let n = 0; n < N; n++) sum += vec[n] * cosRow[n];
    out[k] = (k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N)) * sum;
  }
  return out;
}

// N×N 그레이스케일 행렬에 2D DCT-II 적용 (행 → 열 순서로 분리 적용)
function dct2D(matrix, N) {
  const rowsDone = new Float64Array(N * N);
  const rowBuf = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) rowBuf[x] = matrix[y * N + x];
    rowsDone.set(dct1D(rowBuf), y * N);
  }
  const result = new Float64Array(N * N);
  const colBuf = new Float64Array(N);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) colBuf[y] = rowsDone[y * N + x];
    const colDct = dct1D(colBuf);
    for (let y = 0; y < N; y++) result[y * N + x] = colDct[y];
  }
  return result;
}

function slotRects(imgW, imgH) {
  const rects = [];
  for (const [yMin, yMax] of [[T1_Y_MIN, T1_Y_MAX], [T2_Y_MIN, T2_Y_MAX]]) {
    for (let i = 0; i < 5; i++) {
      rects.push({
        left: Math.round((CARD0_LEFT + i * CARD_PERIOD) * imgW),
        top: Math.round(yMin * imgH),
        width: Math.round(CARD_WIDTH * imgW),
        height: Math.round((yMax - yMin) * imgH),
      });
    }
  }
  return rects;
}

/** @returns {Promise<{hash: string|null, image: string|null}>} 슬롯에 텍스트가 없으면 hash/image 둘 다 null */
async function hashSlot(imageBuffer, rect) {
  if (rect.width <= 0 || rect.height <= 0) return { hash: null, image: null };
  const { data, info } = await sharp(imageBuffer)
    .extract(rect)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const bin = new Uint8Array(width * height);
  let sumX = 0, sumY = 0, sumW = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = data[y * width + x] > 128 ? 255 : 0;
      bin[y * width + x] = on;
      if (on) { sumX += x; sumY += y; sumW++; }
    }
  }
  if (sumW === 0) return { hash: null, image: null };

  // 무게중심을 캔버스 중앙으로 이동 (위치 어긋남에 무관한 해시를 위함)
  const dx = Math.round(width / 2 - sumX / sumW);
  const dy = Math.round(height / 2 - sumY / sumW);
  const shifted = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let x = 0; x < width; x++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      shifted[ny * width + nx] = bin[y * width + x];
    }
  }

  const { data: norm } = await sharp(Buffer.from(shifted), { raw: { width, height, channels: 1 } })
    .resize(DCT_SIZE, DCT_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const matrix = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let i = 0; i < matrix.length; i++) matrix[i] = norm[i];
  const freq = dct2D(matrix, DCT_SIZE);

  // 저주파 8x8 블록 (좌상단) 추출 — DC 성분(0,0) 포함, 구조 정보가 가장 많이 담긴 영역
  const lowFreq = new Float64Array(HASH_BITS * HASH_BITS);
  for (let y = 0; y < HASH_BITS; y++) {
    for (let x = 0; x < HASH_BITS; x++) lowFreq[y * HASH_BITS + x] = freq[y * DCT_SIZE + x];
  }
  const sorted = Array.from(lowFreq).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let hash = 0n;
  for (let i = 0; i < lowFreq.length; i++) {
    hash = (hash << 1n) | (lowFreq[i] > median ? 1n : 0n);
  }

  // 사람이 나중에 phash↔닉네임 매칭을 육안으로 검증할 수 있도록, 원본 컬러 크롭(이진화 전)도 같이 반환
  const croppedJpeg = await sharp(imageBuffer).extract(rect).jpeg({ quality: 85 }).toBuffer();
  return { hash: hash.toString(16).padStart(16, '0'), image: croppedJpeg.toString('base64') };
}

/**
 * @param {Buffer} imageBuffer
 * @returns {Promise<{hash: string|null, image: string|null}[]>} 10개 슬롯 (팀1 5칸 + 팀2 5칸)
 */
async function computeSlotHashes(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata();
  const rects = slotRects(meta.width, meta.height);
  return Promise.all(rects.map((r) => hashSlot(imageBuffer, r).catch(() => ({ hash: null, image: null }))));
}

const LOADING_SCREEN_HIT_THRESHOLD = 150; // 닉네임 흰 텍스트는 ~246, 카드 배경은 ~110~120 — 그 사이값
const LOADING_SCREEN_MIN_CARDS = 4; // 5칸 중 일부는 빈 슬롯일 수 있어 여유를 둠

async function bandLooksLikeCards(imageBuffer, w, h, yMin, yMax) {
  const top = Math.round(yMin * h), height = Math.round((yMax - yMin) * h);
  if (height <= 0) return false;
  const { data, info } = await sharp(imageBuffer)
    .extract({ left: 0, top, width: w, height })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: rw, height: rh } = info;

  let hits = 0;
  for (let i = 0; i < 5; i++) {
    const left = Math.max(0, Math.round((CARD0_LEFT + i * CARD_PERIOD) * w));
    const right = Math.min(rw, left + Math.round(CARD_WIDTH * w));
    let maxBright = 0;
    for (let x = left; x < right; x++) {
      for (let y = 0; y < rh; y++) {
        const v = data[y * rw + x];
        if (v > maxBright) maxBright = v;
      }
    }
    if (maxBright > LOADING_SCREEN_HIT_THRESHOLD) hits++;
  }
  return hits >= LOADING_SCREEN_MIN_CARDS;
}

/**
 * 화면 캡처 썸네일(아무 해상도)이 로딩화면(닉네임 카드 5x2)처럼 보이는지 가볍게 판정.
 * 무거운 OCR/해시 파이프라인을 돌리기 전 1차 필터용 — 카드 좌표 비율은 해상도 무관.
 * @param {Buffer} imageBuffer
 * @returns {Promise<boolean>}
 */
async function looksLikeLoadingScreen(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width, h = meta.height;
  const [t1, t2] = await Promise.all([
    bandLooksLikeCards(imageBuffer, w, h, T1_Y_MIN, T1_Y_MAX),
    bandLooksLikeCards(imageBuffer, w, h, T2_Y_MIN, T2_Y_MAX),
  ]);
  return t1 && t2;
}

module.exports = { computeSlotHashes, looksLikeLoadingScreen };
