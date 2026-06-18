const sharp = require('sharp');

// 닉네임 카드 좌표 — 1920x1080 스크린샷에서 카드 5개의 실제 경계를 픽셀 단위로 직접 측정해 도출.
// 카드1 왼쪽 시작 613px, 카드 반복 주기 211px, 카드 폭 191px (육안 확인: 카드 테두리 선 제외,
// 텍스트가 카드 안에서 가운데 정렬되도록 좌우 여백 조정 완료)
const CARD0_LEFT = 613 / 1920;
const CARD_PERIOD = 211 / 1920;
const CARD_WIDTH = 191 / 1920;
const T1_Y_MIN = 0.355, T1_Y_MAX = 0.385;
const T2_Y_MIN = 0.850, T2_Y_MAX = 0.882;

// DCT 기반 pHash: 카드 슬롯 비율(가로:세로 ≈ 5.9:1)에 맞춘 직사각형으로 리사이즈한 뒤
// 저주파 8x8(=64비트) 성분만 사용. 단순 8x8 평균해시는 이진화+축소 과정에서 글자 모양
// 정보가 거의 사라져 서로 다른 닉네임끼리 해시가 동일해지는 충돌이 실측에서 확인됨
// (Hamming거리 0). DCT는 구조 정보를 주파수 성분으로 압축하므로 구분력이 훨씬 높다.
// 정사각형으로 패딩하면(이전 방식) 가로로 긴 카드 슬롯 특성상 패딩 영역이 너무 커서
// 해상도 낭비가 심함 — 슬롯 자연 비율에 맞는 직사각형(128x24)으로 통일해서 패딩을
// 최소화하면서도 항상 같은 크기로 비교 가능하게 한다.
// DCT 연산은 N^3 수준이라 이 크기에서도 비용은 무시할 수준(1ms 미만).
const DCT_W = 128;
const DCT_H = 24;
const HASH_BITS = 8; // 저주파 8x8 블록 사용 → 64비트

function buildCosTable(size) {
  const table = [];
  for (let k = 0; k < size; k++) {
    const row = new Float64Array(size);
    for (let n = 0; n < size; n++) {
      row[n] = Math.cos((Math.PI / size) * (n + 0.5) * k);
    }
    table.push(row);
  }
  return table;
}
const COS_TABLE_W = buildCosTable(DCT_W);
const COS_TABLE_H = buildCosTable(DCT_H);

function dct1D(vec, cosTable) {
  const N = vec.length;
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    const cosRow = cosTable[k];
    for (let n = 0; n < N; n++) sum += vec[n] * cosRow[n];
    out[k] = (k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N)) * sum;
  }
  return out;
}

// W×H 그레이스케일 행렬에 2D DCT-II 적용 (행 → 열 순서로 분리 적용, 가로/세로 크기가 달라도 됨)
function dct2D(matrix, W, H) {
  const rowsDone = new Float64Array(W * H);
  const rowBuf = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) rowBuf[x] = matrix[y * W + x];
    rowsDone.set(dct1D(rowBuf, COS_TABLE_W), y * W);
  }
  const result = new Float64Array(W * H);
  const colBuf = new Float64Array(H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) colBuf[y] = rowsDone[y * W + x];
    const colDct = dct1D(colBuf, COS_TABLE_H);
    for (let y = 0; y < H; y++) result[y * W + x] = colDct[y];
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

  // 카드 슬롯은 가로로 긴 직사각형(예: ~380x65)이라 fit:'fill'로 바로 리사이즈하면 가로/세로가
  // 서로 다른 비율로 눌려서 글자가 뒤틀림 — 캡처마다 크롭 크기가 1px만 달라져도 뒤틀리는
  // 정도가 달라져 해시가 불안정해지는 원인이었음. DCT_W:DCT_H 비율에 맞는 캔버스로 짧은 쪽만
  // 0(검정)으로 패딩한 다음 리사이즈하면, 패딩도 최소화하면서 항상 같은 비율로 줄어든다.
  const targetAspect = DCT_W / DCT_H;
  const srcAspect = width / height;
  const canvasW = srcAspect > targetAspect ? width : Math.ceil(height * targetAspect);
  const canvasH = srcAspect > targetAspect ? Math.ceil(width / targetAspect) : height;
  const padded = new Uint8Array(canvasW * canvasH);
  const padX = Math.floor((canvasW - width) / 2);
  const padY = Math.floor((canvasH - height) / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      padded[(y + padY) * canvasW + (x + padX)] = shifted[y * width + x];
    }
  }

  const { data: norm } = await sharp(Buffer.from(padded), { raw: { width: canvasW, height: canvasH, channels: 1 } })
    .resize(DCT_W, DCT_H, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const matrix = new Float64Array(DCT_W * DCT_H);
  for (let i = 0; i < matrix.length; i++) matrix[i] = norm[i];
  const freq = dct2D(matrix, DCT_W, DCT_H);

  // 저주파 8x8 블록 (좌상단) 추출 — DC 성분(0,0) 포함, 구조 정보가 가장 많이 담긴 영역
  const lowFreq = new Float64Array(HASH_BITS * HASH_BITS);
  for (let y = 0; y < HASH_BITS; y++) {
    for (let x = 0; x < HASH_BITS; x++) lowFreq[y * HASH_BITS + x] = freq[y * DCT_W + x];
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

// 로딩화면 중앙에 항상 뜨는 금색 "VS" 텍스트 — 실제 캡처 샘플 2장(협력전, 공식전 HERO/ACTION
// TOURNAMENT — 카드 구성도 매치 종류도 다름)에서 좌표가 거의 동일하게 확인됨.
// 처음엔 이 박스 안의 밝기(픽셀이 임계값보다 밝은지)만 봤는데, 인게임 3D 오브젝트의 밝은
// 표면이 카메라 각도상 같은 위치에 잠깐 비치기만 해도 오탐나는 게 실측으로 확인됨(밝기는
// 위치/모양과 무관하니까). 그래서 밝기 대신 실제 VS 글자 "모양"을 기준 템플릿으로 만들어
// 정규화 상관계수(NCC)로 비교한다 — 임의의 밝은 물체는 글자 모양과 거의 상관관계가 없어서
// (실측: 진짜 VS는 0.998, 오탐 사례는 -0.04~-0.08) 훨씬 더 확실하게 구분됨.
const VS_RECT_FRAC = { left: 1040 / 1920, top: 455 / 1080, width: 170 / 1920, height: 130 / 1080 };
const VS_TEMPLATE_W = 64, VS_TEMPLATE_H = 48;
const VS_TEMPLATE = require('./vs-template.json'); // 64x48 그레이스케일, unnamed.png+캡처.PNG 평균
const VS_NCC_THRESHOLD = 0.5; // 진짜(0.998)와 오탐(-0.08~0.0) 사이 압도적인 여유를 둠

const VS_TEMPLATE_MEAN = VS_TEMPLATE.reduce((a, b) => a + b, 0) / VS_TEMPLATE.length;
const VS_TEMPLATE_CENTERED = VS_TEMPLATE.map((v) => v - VS_TEMPLATE_MEAN);
const VS_TEMPLATE_NORM = Math.sqrt(VS_TEMPLATE_CENTERED.reduce((a, b) => a + b * b, 0));

/** @param {number[]|Uint8Array} query @returns {number} -1~1, 1이면 완전 일치 */
function normalizedCrossCorrelation(query) {
  let sum = 0;
  for (let i = 0; i < query.length; i++) sum += query[i];
  const qMean = sum / query.length;
  let dot = 0, qSumSq = 0;
  for (let i = 0; i < query.length; i++) {
    const c = query[i] - qMean;
    dot += c * VS_TEMPLATE_CENTERED[i];
    qSumSq += c * c;
  }
  return dot / (Math.sqrt(qSumSq) * VS_TEMPLATE_NORM + 1e-6);
}

/**
 * 화면 캡처 썸네일(아무 해상도)이 로딩화면(중앙 금색 VS 텍스트)처럼 보이는지 가볍게 판정.
 * 무거운 OCR/해시 파이프라인을 돌리기 전 1차 필터용 — 좌표 비율은 해상도 무관.
 * @param {Buffer} imageBuffer
 * @returns {Promise<boolean>}
 */
async function looksLikeLoadingScreen(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width, h = meta.height;
  const left = Math.round(VS_RECT_FRAC.left * w);
  const top = Math.round(VS_RECT_FRAC.top * h);
  const width = Math.round(VS_RECT_FRAC.width * w);
  const height = Math.round(VS_RECT_FRAC.height * h);
  if (width <= 0 || height <= 0) return false;

  const { data } = await sharp(imageBuffer)
    .extract({ left, top, width, height })
    .resize(VS_TEMPLATE_W, VS_TEMPLATE_H, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return normalizedCrossCorrelation(data) >= VS_NCC_THRESHOLD;
}

module.exports = { computeSlotHashes, looksLikeLoadingScreen };
