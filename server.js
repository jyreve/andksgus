const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 3000;
let publicTunnelUrl = null;

// 로컬 Wi-Fi IP 주소 자동 탐색
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  let fallback = '127.0.0.1';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
          return iface.address;
        }
        fallback = iface.address;
      }
    }
  }
  return fallback;
}

// 초기 상태 생성
// agreeTeam: 현재 라운드에서 '찬성'을 맡은 학년 ('grade2' = 2학년, 'grade3' = 3학년)
function createInitialState() {
  return {
    currentRound: 1,
    totalRounds: 4,
    showFinal: false,
    rounds: {
      1: {
        topic: '체육시간 남녀가 같이 수업을 해도 될까?',
        agreeLabel: '찬성 (같이 수업해도 된다)',
        disagreeLabel: '반대 (분리해서 수업해야 한다)',
        agreeTeam: 'grade2',
        status: 'voting',
        votes: {}
      },
      2: {
        topic: '집안일은 같이 분담해서 해야 하나, 시간이 되는 사람이 해야 되나?',
        agreeLabel: '찬성 (같이 분담해서 해야 한다)',
        disagreeLabel: '반대 (시간이 되는 사람이 해야 한다)',
        agreeTeam: 'grade3',
        status: 'voting',
        votes: {}
      },
      3: {
        topic: '군복무는 다같이 해야 하나?',
        agreeLabel: '찬성 (다같이 해야 한다)',
        disagreeLabel: '반대 (현행 유지 / 다같이 할 필요 없다)',
        agreeTeam: 'grade2',
        status: 'voting',
        votes: {}
      },
      4: {
        topic: '여성전용주차장은 배려인가 역차별인가?',
        agreeLabel: '찬성 (필요한 배려이다)',
        disagreeLabel: '반대 (역차별이다)',
        agreeTeam: 'grade3',
        status: 'voting',
        votes: {}
      }
    }
  };
}

let rawState = createInitialState();
let sseClients = [];

function getPublicState() {
  const localIP = getLocalIP();
  const roundsSummary = {};

  let grade2Wins = 0;
  let grade3Wins = 0;
  let totalDraws = 0;
  let grade2TotalVotes = 0;
  let grade3TotalVotes = 0;

  for (let r = 1; r <= 4; r++) {
    const rd = rawState.rounds[r];
    const agreeTeam = rd.agreeTeam; // 'grade2' | 'grade3'
    const disagreeTeam = agreeTeam === 'grade2' ? 'grade3' : 'grade2';

    const voteValues = Object.values(rd.votes);
    const agreeCount = voteValues.filter(v => v === 'agree').length;
    const disagreeCount = voteValues.filter(v => v === 'disagree').length;
    const totalCount = voteValues.length;

    let winnerSide = null; // 'agree' | 'disagree' | 'draw' | 'none'
    let winnerTeam = null; // 'grade2' | 'grade3' | 'draw' | 'none'

    if (rd.status === 'revealed') {
      const g2VotesThisRound = agreeTeam === 'grade2' ? agreeCount : disagreeCount;
      const g3VotesThisRound = agreeTeam === 'grade3' ? agreeCount : disagreeCount;
      grade2TotalVotes += g2VotesThisRound;
      grade3TotalVotes += g3VotesThisRound;

      if (agreeCount > disagreeCount) {
        winnerSide = 'agree';
        winnerTeam = agreeTeam;
        if (winnerTeam === 'grade2') grade2Wins++;
        else grade3Wins++;
      } else if (disagreeCount > agreeCount) {
        winnerSide = 'disagree';
        winnerTeam = disagreeTeam;
        if (winnerTeam === 'grade2') grade2Wins++;
        else grade3Wins++;
      } else if (totalCount > 0) {
        winnerSide = 'draw';
        winnerTeam = 'draw';
        totalDraws++;
      } else {
        winnerSide = 'none';
        winnerTeam = 'none';
      }
    }

    roundsSummary[r] = {
      round: r,
      topic: rd.topic,
      agreeLabel: rd.agreeLabel || '찬성 측',
      disagreeLabel: rd.disagreeLabel || '반대 측',
      agreeTeam,
      disagreeTeam,
      status: rd.status,
      totalCount,
      agreeCount: rd.status === 'revealed' ? agreeCount : null,
      disagreeCount: rd.status === 'revealed' ? disagreeCount : null,
      winnerSide,
      winnerTeam
    };
  }

  return {
    localIP,
    port: PORT,
    voteUrl: publicTunnelUrl ? `${publicTunnelUrl}/vote` : `http://${localIP}:${PORT}/vote`,
    isTunnelReady: !!publicTunnelUrl,
    currentRound: rawState.currentRound,
    totalRounds: rawState.totalRounds,
    showFinal: rawState.showFinal,
    rounds: roundsSummary,
    summary: {
      grade2Wins,
      grade3Wins,
      totalDraws,
      grade2TotalVotes,
      grade3TotalVotes
    }
  };
}

function broadcast() {
  const data = JSON.stringify(getPublicState());
  sseClients.forEach(res => {
    try {
      res.write(`data: ${data}\n\n`);
    } catch (e) {}
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // SSE 실시간 스트림
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify(getPublicState())}\n\n`);
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(client => client !== res);
    });
    return;
  }

  // 현재 상태 조회 (특정 voterId의 투표 내역 포함)
  if (pathname === '/api/state' && req.method === 'GET') {
    const voterId = urlObj.searchParams.get('voterId');
    const pub = getPublicState();
    let myVotes = {};
    if (voterId) {
      for (let r = 1; r <= 4; r++) {
        myVotes[r] = rawState.rounds[r].votes[voterId] || null;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...pub, myVotes }));
    return;
  }

  // 심사위원 투표 API
  if (pathname === '/api/vote' && req.method === 'POST') {
    const body = await parseBody(req);
    const { voterId, choice, round } = body;
    const targetRound = round || rawState.currentRound;
    const rd = rawState.rounds[targetRound];

    if (!rd) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, message: '유효하지 않은 라운드입니다.' }));
      return;
    }

    if (rd.status === 'revealed') {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, message: '이미 결과가 공개되어 투표가 마감되었습니다.' }));
      return;
    }

    if (voterId && (choice === 'agree' || choice === 'disagree')) {
      rd.votes[voterId] = choice;
      broadcast();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, choice, round: targetRound }));
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: '잘못된 요청입니다.' }));
    return;
  }

  // 교사용 컨트롤 API
  if (pathname === '/api/control' && req.method === 'POST') {
    const body = await parseBody(req);
    const { action, round, topic, agreeTeam } = body;

    if (action === 'setRound') {
      const r = Number(round);
      if (r >= 1 && r <= 4) {
        rawState.currentRound = r;
        rawState.showFinal = false;
      }
    } else if (action === 'setSides') {
      const r = Number(round) || rawState.currentRound;
      if (rawState.rounds[r] && (agreeTeam === 'grade2' || agreeTeam === 'grade3')) {
        rawState.rounds[r].agreeTeam = agreeTeam;
      }
    } else if (action === 'swapSides') {
      const r = Number(round) || rawState.currentRound;
      if (rawState.rounds[r]) {
        rawState.rounds[r].agreeTeam = rawState.rounds[r].agreeTeam === 'grade2' ? 'grade3' : 'grade2';
      }
    } else if (action === 'reveal') {
      const r = rawState.currentRound;
      rawState.rounds[r].status = 'revealed';
    } else if (action === 'reopen') {
      const r = rawState.currentRound;
      rawState.rounds[r].status = 'voting';
    } else if (action === 'resetRound') {
      const r = rawState.currentRound;
      rawState.rounds[r].votes = {};
      rawState.rounds[r].status = 'voting';
      rawState.showFinal = false;
    } else if (action === 'resetAll') {
      const saved = {};
      for (let i = 1; i <= 4; i++) {
        saved[i] = {
          topic: rawState.rounds[i].topic,
          agreeTeam: rawState.rounds[i].agreeTeam
        };
      }
      rawState = createInitialState();
      for (let i = 1; i <= 4; i++) {
        rawState.rounds[i].topic = saved[i].topic;
        rawState.rounds[i].agreeTeam = saved[i].agreeTeam;
      }
    } else if (action === 'setTopic') {
      const r = Number(round) || rawState.currentRound;
      if (rawState.rounds[r] && typeof topic === 'string') {
        rawState.rounds[r].topic = topic.trim() || `${r}라운드 토론 주제`;
      }
    } else if (action === 'toggleFinal') {
      rawState.showFinal = !rawState.showFinal;
    } else if (action === 'showFinal') {
      rawState.showFinal = true;
    } else if (action === 'hideFinal') {
      rawState.showFinal = false;
    }

    broadcast();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, state: getPublicState() }));
    return;
  }

  // 페이지 라우팅
  if (pathname === '/' || pathname === '/teacher') {
    const filePath = path.join(__dirname, 'public', 'teacher.html');
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading teacher.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  if (pathname === '/vote') {
    const filePath = path.join(__dirname, 'public', 'vote.html');
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading vote.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('페이지를 찾을 수 없습니다.');
});

// 학교 방화벽/망분리를 우회하여 LTE/5G 어디서든 접속 가능한 외부 HTTPS 터널 자동 생성
function startCloudflareTunnel() {
  console.log('🌐 스마트폰(LTE/5G/와이파이 무관) 접속용 보안 터널을 생성하는 중입니다...');
  const cf = spawn('npx.cmd', ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], {
    shell: true
  });

  const handleOutput = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !publicTunnelUrl) {
      publicTunnelUrl = match[0];
      console.log('====================================================');
      console.log('✅ 외부 인터넷(LTE/5G) QR 접속 주소 생성 완료!');
      console.log(`📱 새 QR 투표 주소: ${publicTunnelUrl}/vote`);
      console.log('====================================================');
      broadcast();
    }
  };

  cf.stdout.on('data', handleOutput);
  cf.stderr.on('data', handleOutput);
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('====================================================');
  console.log('🎉 [2학년 vs 3학년 보건수업 실시간 토론 배틀] 서버 가동!');
  console.log(`🖥️ 교사용 전광판 주소: http://localhost:${PORT}`);
  console.log(`📱 로컬 투표 주소: http://${ip}:${PORT}/vote`);
  console.log('====================================================');
  startCloudflareTunnel();
});
