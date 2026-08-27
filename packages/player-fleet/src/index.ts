// player-fleet: N synthetic sessions that fetch personalized manifests through
// the edge, "play" them on a wall clock (no decode — exactly how real load-test
// fleets work), and fire the six IAB tracking events per creative.
import { CDNS, DEVICE_CLASSES, REGIONS, createService } from '@adbreak/shared';

const svc = createService('player-fleet');
const EDGE_URL = process.env.EDGE_URL ?? 'http://edge:3000';
const SESSIONS = Number(process.env.SESSIONS ?? 200);
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 4000);
const ISPS = ['comcast', 'charter', 'att', 'verizon'];

/** Quartile offsets: impression+start at 0, then 25/50/75/100%. */
const EVENT_FRACTIONS: Record<string, number> = {
  impression: 0,
  start: 0,
  firstQuartile: 0.25,
  midpoint: 0.5,
  thirdQuartile: 0.75,
  complete: 1,
};

const sessionsGauge = svc.gauge({
  name: 'adbreak_fleet_sessions',
  help: 'Virtual player sessions currently running',
  labels: ['device_class', 'region', 'cdn'] as const,
});
const fetchErrors = svc.counter({
  name: 'adbreak_fleet_fetch_errors_total',
  help: 'Playlist/segment fetch failures seen by the fleet',
  labels: ['kind'] as const,
});
const beaconsFiredClient = svc.counter({
  name: 'adbreak_fleet_beacons_fired_total',
  help: 'Tracking beacons the players attempted to fire',
  labels: ['event', 'device_class'] as const,
});

const pick = <T>(arr: readonly T[], i: number): T => arr[i % arr.length];

interface Player {
  id: string;
  deviceClass: string;
  region: string;
  cdn: string;
  isp: string;
  headers: Record<string, string>;
  query: string;
  scheduled: Set<string>;
}

function makePlayer(i: number): Player {
  const deviceClass = pick(DEVICE_CLASSES, i);
  const region = pick(REGIONS, Math.floor(i / DEVICE_CLASSES.length));
  // CDN affinity follows region, as real traffic does.
  const cdn = region === 'us-west' ? CDNS[1] : CDNS[0];
  const isp = pick(ISPS, i);
  const id = `sess-${String(i).padStart(4, '0')}`;
  return {
    id,
    deviceClass,
    region,
    cdn,
    isp,
    headers: {
      'X-Session': id,
      'X-Device-Class': deviceClass,
      'X-Cdn': cdn,
      'X-Region': region,
    },
    query: new URLSearchParams({
      device_class: deviceClass,
      region,
      cdn,
      isp,
    }).toString(),
    scheduled: new Set(),
  };
}

async function fireBeacon(p: Player, event: string, url: string): Promise<void> {
  try {
    const res = await fetch(url, { headers: p.headers });
    // A rejected beacon is NOT a fired beacon — counting it either way would
    // hide exactly the kind of silent billing loss this system exists to catch.
    if (!res.ok && res.status !== 204) {
      fetchErrors.inc({ kind: 'beacon_rejected' });
      svc.log.warn('beacon rejected', { session_id: p.id, event, status: res.status });
      return;
    }
    beaconsFiredClient.inc({ event, device_class: p.deviceClass });
  } catch (err) {
    fetchErrors.inc({ kind: 'beacon' });
    svc.log.warn('beacon fire failed', { session_id: p.id, event, err: String(err) });
  }
}

interface TrackingAvail {
  availId: string;
  startTime: string;
  creatives: { id: string; durationS: number; offsetS: number; tracking: Record<string, string> }[];
}

function scheduleBeacons(p: Player, avails: TrackingAvail[]): void {
  const now = Date.now();
  for (const avail of avails) {
    avail.creatives.forEach((creative, pos) => {
      // Keyed by pod position, not creative id: a pod may legitimately carry
      // the same spot twice, and each is a separate billable impression.
      const key = `${avail.availId}|${pos}|${creative.id}`;
      if (p.scheduled.has(key)) return;
      p.scheduled.add(key);
      const creativeStart = Date.parse(avail.startTime) + creative.offsetS * 1000;
      for (const [event, fraction] of Object.entries(EVENT_FRACTIONS)) {
        const url = creative.tracking[event];
        if (!url) continue;
        const at = creativeStart + fraction * creative.durationS * 1000;
        // A player that joins mid-ad still reports the events it played through.
        const delay = Math.max(0, at - now);
        setTimeout(() => void fireBeacon(p, event, url), delay);
      }
    });
  }
}

async function cycle(p: Player): Promise<void> {
  try {
    const res = await fetch(`${EDGE_URL}/session/${p.id}/playlist.m3u8?${p.query}`, {
      headers: p.headers,
    });
    if (!res.ok) {
      fetchErrors.inc({ kind: 'playlist' });
      return;
    }
    const playlist = await res.text();

    // Sample one segment per cycle so segment delivery is genuinely exercised.
    const uri = playlist.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).pop();
    if (uri) {
      const segRes = await fetch(`${EDGE_URL}${uri}`, { headers: p.headers });
      if (!segRes.ok) fetchErrors.inc({ kind: 'segment' });
      else await segRes.arrayBuffer();
    }

    const avails = (await fetch(`${EDGE_URL}/session/${p.id}/tracking?${p.query}`, {
      headers: p.headers,
    }).then((r) => r.json())) as TrackingAvail[];
    scheduleBeacons(p, avails);
  } catch (err) {
    fetchErrors.inc({ kind: 'cycle' });
    svc.log.warn('cycle failed', { session_id: p.id, err: String(err) });
  }
}

const players = Array.from({ length: SESSIONS }, (_, i) => makePlayer(i));
for (const p of players) {
  sessionsGauge.inc({ device_class: p.deviceClass, region: p.region, cdn: p.cdn });
  // Jitter start so 200 clients don't stampede the edge in lockstep.
  setTimeout(() => {
    void cycle(p);
    setInterval(() => void cycle(p), CYCLE_MS);
  }, Math.random() * CYCLE_MS);
}

svc.log.info('fleet started', { sessions: SESSIONS, edge: EDGE_URL });
svc.start(Number(process.env.PORT ?? 3000));
