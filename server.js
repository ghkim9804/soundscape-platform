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

const DATA_FILE = path.join(__dirname, 'data', 'responses.json');

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

// ── 자극 목록 자동 감지 ──────────────────────────────────────────
app.get('/api/stimuli', (req, res) => {
  const imagesDir = path.join(__dirname, 'input', 'images');
  const soundsDir = path.join(__dirname, 'input', 'sounds');

  const stimuli = [];
  const IMAGE_EXTS = /\.(jpg|jpeg|png|webp|gif)$/i;
  const SOUND_EXTS = ['mp3', 'wav', 'ogg', 'm4a'];

  // 파일명 형식: {L1~L6}_{vegetation|vehicle|human}_{20|40|60|80}.ext
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

  // 정렬: 장소 → 카테고리 → 비율
  stimuli.sort((a, b) => {
    if (a.location !== b.location) return a.location.localeCompare(b.location);
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.ratio - b.ratio;
  });

  // 파일 없을 때 데모용 더미 자극 목록 반환
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
app.post('/api/responses', (req, res) => {
  const data = readData();
  const entry = {
    ...req.body,
    timestamp: new Date().toISOString(),
    id: Date.now().toString()
  };
  data.responses.push(entry);
  writeData(data);
  res.json({ success: true, id: entry.id });
});

// ── 응답 조회 ────────────────────────────────────────────────────
app.get('/api/responses', (req, res) => {
  const data = readData();
  const { stimulusId, location } = req.query;

  let result = data.responses;
  if (stimulusId) result = result.filter(r => r.stimulusId === stimulusId);
  if (location) result = result.filter(r => r.location === location);

  // ISO PE 좌표 계산하여 반환
  result = result.map(r => ({
    ...r,
    pe: calcPE(r.paq)
  }));

  res.json({ responses: result, total: data.responses.length });
});

// ── ISO PE 좌표 계산 함수 ─────────────────────────────────────────
// PAQ 4개 양극 척도 → P, E 좌표 (-1 ~ +1)
// r1: 쾌적한(+2) ↔ 불쾌한(-2)   → Pleasant axis
// r2: 활기찬(+2) ↔ 단조로운(-2) → Vibrant axis (45°)
// r3: 활동적(+2) ↔ 정적인(-2)   → Eventful axis (90°)
// r4: 고요한(+2) ↔ 혼잡한(-2)   → Calm axis (315°)
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
// 같은 장소 × 같은 카테고리, 인접 비율끼리 쌍 만들기
// (20↔40), (40↔60), (60↔80) — 또는 전체 조합
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

  // 데모용 더미
  if (stimuli.length === 0) {
    const locations = ['L1','L2','L3','L4','L5','L6'];
    const categories = ['vegetation','vehicle','human'];
    const ratios = [20, 40, 60, 80];
    locations.forEach(loc => categories.forEach(cat => ratios.forEach(r => {
      stimuli.push({ id: `${loc}_${cat}_${r}`, location: loc, category: cat, ratio: r, imageFile: null, soundFile: null, demo: true });
    })));
  }

  // 같은 location+category 그룹에서 인접 비율 쌍 생성
  const groups = {};
  stimuli.forEach(s => {
    const key = `${s.location}_${s.category}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  });

  const pairs = [];
  Object.values(groups).forEach(group => {
    group.sort((a, b) => a.ratio - b.ratio);
    // 인접 쌍: (20,40), (40,60), (60,80)
    for (let i = 0; i < group.length - 1; i++) {
      pairs.push({
        pairId: `${group[i].id}_vs_${group[i+1].id}`,
        stimA: group[i],
        stimB: group[i + 1]
      });
    }
  });

  // 랜덤 셔플
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }

  res.json(pairs);
});

// ── 비교 응답 저장 ─────────────────────────────────────────────────
const COMP_FILE = path.join(__dirname, 'data', 'comparisons.json');
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
