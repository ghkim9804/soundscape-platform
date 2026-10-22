const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use(cors());

// 자극 파일 서빙
app.use('/stimuli/images', express.static(path.join(__dirname, 'input', 'images')));
app.use('/stimuli/sounds', express.static(path.join(__dirname, 'input', 'sounds')));

// Railway 볼륨 마운트 경로 우선, 없으면 로컬 data/ 사용
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE = path.join(DATA_DIR, 'responses.json');
const COMP_FILE = path.join(DATA_DIR, 'comparisons.json');

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { responses: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Google Sheets 웹훅 ───────────────────────────────────────────
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyoEvY1ig3xNf5CR1F13yJGYzxkAQzL5Hi7uGE5hB6GYz5pKSN5fD_kQuoyX7hYJoannw/exec';

async function sendToSheets(entry) {
  try {
    const https = require('https');
    const url = new URL(SHEETS_URL);
    const body = JSON.stringify(entry);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    await new Promise((resolve) => {
      const req = https.request(options, resolve);
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
  } catch {}
}

// ── 자극 목록 자동 감지 ──────────────────────────────────────────
app.get('/api/stimuli', (req, res) => {
  const imagesDir = path.join(__dirname, 'input', 'images');
  const soundsDir = path.join(__dirname, 'input', 'sounds');

  const stimuli = [];
  const IMAGE_EXTS = /\.(jpg|jpeg|png|webp|gif)$/i;
  const SOUND_EXTS = ['mp3', 'wav', 'ogg', 'm4a'];

  if (fs.existsSync(imagesDir)) {
    const images = fs.readdirSync(imagesDir).filter(f => IMAGE_EXTS.test(f));

    images.forEach(img => {
      const match = img.match(/^(L[1-6])_(vegetation|vehicle|human)_(\d+)\./i);
      if (!match) return;

      const [, location, category, ratio] = match;
      const soundFile = SOUND_EXTS.map(ext =>
        `${location}_${category}_${ratio}.${ext}`
      ).find(name => fs.existsSync(path.join(soundsDir, name)));

      if (soundFile) {
        stimuli.push({
          id: `${location}_${category}_${ratio}`,
          location,
          category,
          ratio: parseInt(ratio),
          imageFile: img,
          soundFile
        });
      }
    });
  }

  stimuli.sort((a, b) => {
    if (a.location !== b.location) return a.location.localeCompare(b.location);
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.ratio - b.ratio;
  });

  if (stimuli.length === 0) {
    const locations = ['L1','L2','L3','L4','L5','L6'];
    const categories = ['vegetation','vehicle','human'];
    const ratios = [20, 40, 60, 80];
    locations.forEach(loc => {
      categories.forEach(cat => {
        ratios.forEach(r => {
          stimuli.push({
            id: `${loc}_${cat}_${r}`,
            location: loc,
            category: cat,
            ratio: r,
            imageFile: null,
            soundFile: null,
            demo: true
          });
        });
      });
    });
  }

  res.json(stimuli);
});

// ── 응답 저장 ────────────────────────────────────────────────────
app.post('/api/responses', async (req, res) => {
  const data = readData();
  const entry = {
    ...req.body,
    timestamp: new Date().toISOString(),
    id: Date.now().toString()
  };
  data.responses.push(entry);
  writeData(data);
  sendToSheets(entry); // 구글시트에도 전송 (비동기, 실패해도 무관)
  res.json({ success: true, id: entry.id });
});

// ── 응답 조회 ────────────────────────────────────────────────────
app.get('/api/responses', (req, res) => {
  const data = readData();
  const { stimulusId, location } = req.query;

  let result = data.responses;
  if (stimulusId) result = result.filter(r => r.stimulusId === stimulusId);
  if (location) result = result.filter(r => r.location === location);

  result = result.map(r => ({
    ...r,
    pe: calcPE(r.paq)
  }));

  res.json({ responses: result, total: data.responses.length });
});

// ── ISO PE 좌표 계산 함수 ─────────────────────────────────────────
function calcPE(paq) {
  if (!paq) return { P: 0, E: 0 };
  const sqrt2over2 = Math.sqrt(2) / 2;
  const { r1 = 0, r2 = 0, r3 = 0, r4 = 0 } = paq;
  const P = (r1 + (r2 + r4) * sqrt2over2) / (2 + 2 * sqrt2over2);
  const E = (r3 + (r2 - r4) * sqrt2over2) / (2 + 2 * sqrt2over2);
  return {
    P: Math.max(-1, Math.min(1, P)),
    E: Math.max(-1, Math.min(1, E))
  };
}

// ── 통계 요약 ────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const data = readData();
  const { stimulusId } = req.query;

  let filtered = stimulusId
    ? data.responses.filter(r => r.stimulusId === stimulusId)
    : data.responses;

  if (filtered.length === 0) return res.json({ count: 0 });

  const pePoints = filtered.map(r => calcPE(r.paq));
  const meanP = pePoints.reduce((s, p) => s + p.P, 0) / pePoints.length;
  const meanE = pePoints.reduce((s, p) => s + p.E, 0) / pePoints.length;

  const calcMean = (key) => {
    const vals = filtered.map(r => r[key]).filter(v => v !== undefined);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };

  res.json({
    count: filtered.length,
    meanPE: { P: meanP, E: meanE },
    satisfaction: calcMean('satisfaction'),
    suitability: calcMean('suitability'),
    appropriateness: calcMean('appropriateness'),
    aiLikeness: calcMean('aiLikeness'),
    paqMeans: {
      r1: calcMean('paq.r1'),
      r2: calcMean('paq.r2'),
      r3: calcMean('paq.r3'),
      r4: calcMean('paq.r4')
    }
  });
});

// ── 비교 쌍 생성 ──────────────────────────────────────────────────
app.get('/api/pairs', (req, res) => {
  const imagesDir = path.join(__dirname, 'input', 'images');
  const soundsDir = path.join(__dirname, 'input', 'sounds');
  const IMAGE_EXTS = /\.(jpg|jpeg|png|webp|gif)$/i;
  const SOUND_EXTS = ['mp3', 'wav', 'ogg', 'm4a'];

  let stimuli = [];

  if (fs.existsSync(imagesDir)) {
    const images = fs.readdirSync(imagesDir).filter(f => IMAGE_EXTS.test(f));
    images.forEach(img => {
      const match = img.match(/^(L[1-6])_(vegetation|vehicle|human)_(\d+)\./i);
      if (!match) return;
      const [, location, category, ratio] = match;
      const soundFile = SOUND_EXTS.map(ext =>
        `${location}_${category}_${ratio}.${ext}`
      ).find(name => fs.existsSync(path.join(soundsDir, name)));
      if (soundFile) {
        stimuli.push({ id: `${location}_${category}_${ratio}`, location, category, ratio: parseInt(ratio), imageFile: img, soundFile });
      }
    });
  }

  if (stimuli.length === 0) {
    const locations = ['L1','L2','L3','L4','L5','L6'];
    const categories = ['vegetation','vehicle','human'];
    const ratios = [20, 40, 60, 80];
    locations.forEach(loc => categories.forEach(cat => ratios.forEach(r => {
      stimuli.push({ id: `${loc}_${cat}_${r}`, location: loc, category: cat, ratio: r, imageFile: null, soundFile: null, demo: true });
    })));
  }

  const groups = {};
  stimuli.forEach(s => {
    const key = `${s.location}_${s.category}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  });

  const pairs = [];
  Object.values(groups).forEach(group => {
    group.sort((a, b) => a.ratio - b.ratio);
    for (let i = 0; i < group.length - 1; i++) {
      pairs.push({
        pairId: `${group[i].id}_vs_${group[i+1].id}`,
        stimA: group[i],
        stimB: group[i + 1]
      });
    }
  });

  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }

  res.json(pairs);
});

// ── 비교 응답 저장 ─────────────────────────────────────────────────
function readComps() {
  try { return JSON.parse(fs.readFileSync(COMP_FILE, 'utf8')); } catch { return { comparisons: [] }; }
}
function writeComps(data) { fs.writeFileSync(COMP_FILE, JSON.stringify(data, null, 2)); }

app.post('/api/comparisons', (req, res) => {
  const data = readComps();
  const entry = { ...req.body, timestamp: new Date().toISOString(), id: Date.now().toString() };
  data.comparisons.push(entry);
  writeComps(data);
  res.json({ success: true });
});

app.get('/api/comparisons', (req, res) => {
  res.json(readComps());
});

// ── 비교 결과 CSV ──────────────────────────────────────────────────
app.get('/api/export/comparisons-csv', (req, res) => {
  const data = readComps();
  if (!data.comparisons.length) return res.status(404).json({ error: '비교 데이터 없음' });
  const headers = ['id','timestamp','participantId','pairId','stimA_id','stimB_id','location','category','ratioA','ratioB','preference','preferenceLabel','age','gender'];
  const rows = data.comparisons.map(r => [
    r.id, r.timestamp, r.participantId, r.pairId,
    r.stimA_id, r.stimB_id, r.location, r.category, r.ratioA, r.ratioB,
    r.preference, r.preferenceLabel, r.age ?? '', r.gender ?? ''
  ].map(v => `"${v}"`).join(','));
  const csv = '﻿' + [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="soundscape_comparisons.csv"');
  res.send(csv);
});

// ── CSV 내보내기 ──────────────────────────────────────────────────
app.get('/api/export/csv', (req, res) => {
  const data = readData();
  if (!data.responses.length) {
    return res.status(404).json({ error: '데이터 없음' });
  }

  const headers = [
    'id', 'timestamp', 'participantId', 'stimulusId', 'location', 'category', 'ratio',
    'paq_r1_pleasant_annoying', 'paq_r2_vibrant_monotonous',
    'paq_r3_eventful_uneventful', 'paq_r4_calm_chaotic',
    'PE_P', 'PE_E',
    'satisfaction', 'suitability', 'appropriateness', 'aiLikeness',
    'age', 'gender', 'listenDuration'
  ];

  const rows = data.responses.map(r => {
    const pe = calcPE(r.paq);
    return [
      r.id, r.timestamp, r.participantId, r.stimulusId, r.location, r.category, r.ratio,
      r.paq?.r1 ?? '', r.paq?.r2 ?? '', r.paq?.r3 ?? '', r.paq?.r4 ?? '',
      pe.P.toFixed(4), pe.E.toFixed(4),
      r.satisfaction ?? '', r.suitability ?? '', r.appropriateness ?? '', r.aiLikeness ?? '',
      r.age ?? '', r.gender ?? '', r.listenDuration ?? ''
    ].map(v => `"${v}"`).join(',');
  });

  const csv = '﻿' + [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="soundscape_responses.csv"');
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`\n🎵 음환경 평가 플랫폼`);
  console.log(`   설문 주소:    http://localhost:${PORT}`);
  console.log(`   비교 세션:    http://localhost:${PORT}/compare.html`);
  console.log(`   결과 확인:    http://localhost:${PORT}/results.html\n`);
});