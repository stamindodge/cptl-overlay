/**
 * @typedef {{ ok: boolean, team1: string[], team2: string[] }} ParseResult
 * @typedef {{ ok: boolean, prob: number|null, t1Avg: number|null, t2Avg: number|null, players: Record<string, PlayerResult> }} PredictResult
 * @typedef {{ ok: boolean, estimatedSkillRp?: number, currentRp?: number, mode?: string }} PlayerResult
 */

/**
 * @param {string} workerUrl
 * @param {string} base64
 * @param {(string|null)[]} [phashes] 10개 슬롯의 pHash hex (팀1 5칸 + 팀2 5칸)
 * @param {(string|null)[]} [slotImages] 10개 슬롯의 크롭 이미지(base64 JPEG) — 사람이 phash↔닉네임 검증할 때 R2에 저장됨
 * @returns {Promise<ParseResult>}
 */
async function parseScreenshot(workerUrl, base64, phashes, slotImages) {
  const resp = await fetch(`${workerUrl}/parse-screenshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      image: base64,
      ...(phashes ? { phashes } : {}),
      ...(slotImages ? { slotImages } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`parse-screenshot ${resp.status}`);
  return resp.json();
}

/**
 * @param {string} workerUrl
 * @param {string[]} team1
 * @param {string[]} team2
 * @returns {Promise<PredictResult>}
 */
async function predict(workerUrl, team1, team2) {
  const resp = await fetch(`${workerUrl}/predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ team1, team2 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`predict ${resp.status}`);
  return resp.json();
}

module.exports = { parseScreenshot, predict };
