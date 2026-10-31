import {
  DENSE_SIZE,
  estimateStageSeconds,
  recommendedFaces,
  type Job,
  type Quality,
  type StageName,
} from './models';

export interface Advice {
  tone: 'good' | 'warn' | 'tip';
  title: string;
  detail: string;
}

const QUALITIES: Quality[] = ['preview', 'medium', 'high'];
/** Matches needed between two frames for COLMAP to place one from the other comfortably. */
const SOLID_MATCHES = 300;
const WEAK_MATCHES = 150;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const big = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const fps = (n: number) => `${Math.round(n * 100) / 100} fps`;
const minutes = (s: number) =>
  s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.max(1, Math.round(s / 60))} min`;

function stageSeconds(job: Job, name: StageName) {
  return job.stages
    .filter((s) => s.name === name && s.finishedAt)
    .reduce((n, s) => n + (Date.parse(s.finishedAt!) - Date.parse(s.startedAt)) / 1000, 0);
}

/**
 * Reads a finished run's statistics and says what limited it and which settings to change next
 * time: coverage (were enough images placed), video frame density (too sparse or more than
 * needed), and whether detail was capped by triangles, by dense resolution, or by the capture.
 */
export function runAdvice(job: Job): Advice[] {
  const s = job.stats;
  const out: Advice[] = [];
  const images = s.images ?? 0;
  const placed = s.registeredImages ?? 0;
  const coverage = images ? placed / images : 0;
  const rate = job.settings.videoFps;
  const gaps = s.matchesByGap ?? [];
  const neighbours = gaps.find((g) => g.gap === 1);

  // 1. Coverage: did COLMAP manage to place the images?
  if (images && s.registeredImages !== undefined) {
    const summary = `${placed.toLocaleString()} of ${images.toLocaleString()} images placed (${pct(coverage)}).`;
    if (coverage >= 0.9) {
      out.push({ tone: 'good', title: 'Enough overlap', detail: summary });
    } else {
      const why: string[] = [];
      if (s.models && s.models > 1) {
        why.push(
          `The images split into ${s.models} separate pieces and only the largest was kept. ` +
            'Gaps usually come from fast turns, views of sky or blank walls, or things moving.',
        );
      }
      if (s.videos && neighbours && neighbours.low >= SOLID_MATCHES && (s.models ?? 1) > 1) {
        why.push(
          `Neighbouring frames match well (${neighbours.low}+ matches), so the footage is fine ` +
            'and the mapper failed to join the pieces. Run it again: video runs now use the ' +
            'global mapper, which joins long flights far more reliably.',
        );
      } else if (s.videos && neighbours && neighbours.low < SOLID_MATCHES) {
        why.push(
          `Neighbouring frames share few matches, so raise the frame rate to ${fps(rate * 2)} ` +
            'or move the camera more slowly.',
        );
      } else if (s.photos && !s.videos) {
        why.push('Take more photos with 60–80% overlap, moving a step between shots.');
      } else {
        why.push('Go back over the missing parts slowly, with more overlap.');
      }
      out.push({
        tone: 'warn',
        title: coverage < 0.6 ? 'Most of the capture was not used' : 'Part of the capture was not used',
        detail: `${summary} ${why.join(' ')}`,
      });
    }
  }

  // 2. Video frame density, measured from matches between frames 1, 2, 4 and 8 apart.
  if (s.videos && neighbours) {
    if (neighbours.low < WEAK_MATCHES) {
      out.push({
        tone: 'warn',
        title: 'Video frames too far apart',
        detail:
          `1 in 5 neighbouring frames share fewer than ${neighbours.low} matches. Try ` +
          `${fps(rate * 2)} next time, or film more slowly.`,
      });
    } else {
      const spare = gaps.filter((g) => g.gap > 1 && g.low >= SOLID_MATCHES).at(-1);
      if (spare && coverage >= 0.9) {
        const dense = stageSeconds(job, 'Dense stereo');
        const saved = dense ? ` (dense stereo took ${minutes(dense)}; expect about ${minutes(dense / spare.gap)})` : '';
        out.push({
          tone: 'tip',
          title: `${fps(rate / spare.gap)} would have been enough`,
          detail:
            `Frames ${spare.gap} apart still share ${spare.low}+ matches in 80% of pairs, so ` +
            `${fps(rate / spare.gap)} would cover the same ground with 1/${spare.gap} of the ` +
            `images and roughly 1/${spare.gap} of the processing time${saved}. ` +
            'Keep the higher rate if parts of the flight were fast.',
        });
      } else if (coverage >= 0.9) {
        out.push({
          tone: 'good',
          title: `${fps(rate)} suits this footage`,
          detail: 'Frames further apart lose too many matches, so a lower rate would risk gaps.',
        });
      }
    }
  }

  // 3. What capped the detail: triangles, dense resolution, or the capture itself.
  const target = job.settings.targetFaces;
  if (s.rawMeshFaces && s.meshFaces) {
    if (s.rawMeshFaces > target * 1.5) {
      const printFaces = recommendedFaces(job.settings.printSizeMm);
      out.push({
        tone: 'tip',
        title: 'Triangles limited the 3D view',
        detail:
          `COLMAP's mesh had ${big(s.rawMeshFaces)} triangles and the model kept ${big(s.meshFaces)}. ` +
          `Raise the triangle count (up to ${big(s.rawMeshFaces)}) for a sharper on-screen model. ` +
          `For a ${job.settings.printSizeMm} mm print, ${big(printFaces)} is already finer than ` +
          'a printer can show.',
      });
    } else {
      out.push({
        tone: 'good',
        title: 'All triangles kept',
        detail:
          `The model kept all ${big(s.rawMeshFaces)} triangles COLMAP produced, so more triangles ` +
          "won't add detail. Detail is limited by the dense point cloud.",
      });
    }
  }

  const q = job.settings.quality;
  const next = QUALITIES[QUALITIES.indexOf(q) + 1];
  if (s.sourceWidth && next && s.sourceWidth > DENSE_SIZE[q] * 1.2 && coverage >= 0.6) {
    const est = (quality: Quality) =>
      estimateStageSeconds({
        images,
        photos: s.photos ?? 0,
        videos: s.videos ?? 0,
        quality,
        targetFaces: target,
      })['Dense stereo'];
    const factor = est(next) / est(q);
    const dense = stageSeconds(job, 'Dense stereo');
    out.push({
      tone: 'tip',
      title: `${next[0].toUpperCase()}${next.slice(1)} quality would add detail`,
      detail:
        `Dense stereo used ${DENSE_SIZE[q]} px of your ${s.sourceWidth} px images. ` +
        `${next[0].toUpperCase()}${next.slice(1)} uses ${Math.min(DENSE_SIZE[next], s.sourceWidth)} px ` +
        `for finer surfaces, at about ${factor.toFixed(1)}× the dense stereo time` +
        (dense ? ` (~${minutes(dense * factor)} instead of ${minutes(dense)}).` : '.'),
    });
  } else if (s.sourceWidth && s.sourceWidth <= DENSE_SIZE[q] && coverage >= 0.6) {
    out.push({
      tone: 'good',
      title: 'Full image resolution used',
      detail:
        `Dense stereo already used your full ${s.sourceWidth} px images. For more detail, film ` +
        'at a higher resolution or get closer to what matters.',
    });
  }

  // 4. Sharpness: high reprojection error points at blur or rolling shutter.
  if (s.reprojectionError && s.reprojectionError > 1.2) {
    out.push({
      tone: 'warn',
      title: 'Images may be blurry',
      detail:
        `Average reprojection error is ${s.reprojectionError.toFixed(2)} px (under 1 px is ` +
        'typical). Fast movement or slow shutter speeds blur detail; move more slowly or use more light.',
    });
  }

  // 5. Where the time went.
  const total = job.stages
    .filter((t) => t.finishedAt)
    .reduce((n, t) => n + (Date.parse(t.finishedAt!) - Date.parse(t.startedAt)) / 1000, 0);
  const dense = stageSeconds(job, 'Dense stereo');
  if (total > 600 && dense / total > 0.6) {
    out.push({
      tone: 'tip',
      title: `Dense stereo took ${pct(dense / total)} of the time`,
      detail:
        `${minutes(dense)} of ${minutes(total)}. Its time grows with the number of images, the ` +
        'quality preset (image size and comparison views) and the GPU. Fewer frames or a lower ' +
        'preset are the biggest levers.',
    });
  }

  return out;
}
