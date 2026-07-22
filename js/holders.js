import { t } from './i18n.js';

function getProgressMessage(p) {
  if (p.phase === 'computing') return t('progress.computing');
  if (p.phase === 'fetching') {
    const c = p.creaturePages, l = p.landPages;
    if (c > 0 && l > 0) return t('progress.both').replace('{c}', c).replace('{l}', l);
    if (c > 0) return t('progress.creatures').replace('{n}', c);
    if (l > 0) return t('progress.land').replace('{n}', l);
    return t('progress.connecting');
  }
  return t('holders.loading');
}

function makeBarChart(canvasId, distribution, color) {
  new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels: distribution.map(b => b.label),
      datasets: [{
        data: distribution.map(b => b.count),
        backgroundColor: color,
        borderColor: '#141317',
        borderWidth: 2,
        borderRadius: 8,
        borderSkipped: false,
      }],
    },
    options: {
      animation: { duration: 700 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) { return `  ${ctx.parsed.y.toLocaleString()} ${t('chart.wallets')}`; },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { font: { family: "'Museo Sans Rounded', sans-serif", size: 10, weight: '700' }, color: '#7D7C88' },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.08)' },
          border: { display: false },
          ticks: { font: { family: "'Museo Sans Rounded', sans-serif", size: 10, weight: '700' }, color: '#7D7C88', maxTicksLimit: 5 },
        },
      },
    },
  });
}

export async function loadHoldersChart() {
  const loadingEl   = document.getElementById('holders-loading');
  const loadingMsg  = document.getElementById('holders-loading-msg');
  const errorEl     = document.getElementById('holders-error');
  const errorMsg    = document.getElementById('holders-error-msg');
  const chartWrapEl = document.getElementById('holders-chart-wrap');

  const poll = setInterval(async () => {
    try {
      const r = await fetch('/api/holders/progress');
      const p = await r.json();
      loadingMsg.textContent = getProgressMessage(p);
    } catch {}
  }, 600);

  try {
    const res = await fetch('/api/holders');
    clearInterval(poll);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    loadingEl.hidden = true;
    chartWrapEl.hidden = false;

    document.getElementById('stat-creature-holders').textContent = data.totalCreatureHolders.toLocaleString();
    document.getElementById('stat-land-holders').textContent = data.totalLandHolders.toLocaleString();
    document.getElementById('stat-total-holders').textContent = data.totalUniqueHolders.toLocaleString();

    const d = new Date(data.lastFetched);
    const dateStr = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const updatedEl = document.getElementById('holders-updated');
    updatedEl.innerHTML = `${t('holders.asOf').replace('{date}', dateStr)}${data.stale ? ` <span class="stale-badge">${t('stale.badge')}</span>` : ''}`;

    new Chart(document.getElementById('holders-chart'), {
      type: 'doughnut',
      data: {
        labels: [t('chart.creaturesOnly'), t('chart.landOnly'), t('chart.both')],
        datasets: [{
          data: [data.creaturesOnly, data.landOnly, data.both],
          backgroundColor: ['#51FFA5', '#FFF95F', '#8561FF'],
          borderColor: '#141317',
          borderWidth: 3,
          hoverOffset: 10,
        }],
      },
      options: {
        animation: { duration: 700 },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              font: { family: "'Museo Sans Rounded', sans-serif", size: 11, weight: '700' },
              color: '#CCCADC',
              padding: 22,
              usePointStyle: true,
              pointStyleWidth: 14,
            },
          },
          tooltip: {
            callbacks: {
              label(ctx) {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct = ((ctx.parsed / total) * 100).toFixed(1);
                return `  ${ctx.parsed.toLocaleString()} ${t('chart.wallets')} (${pct}%)`;
              },
            },
          },
        },
        cutout: '58%',
        radius: '88%',
      },
    });

    makeBarChart('chart-creature-dist', data.creatureDistribution, '#51FFA5');
    makeBarChart('chart-land-dist',     data.landDistribution,     '#FFF95F');
    makeBarChart('chart-combined-dist', data.combinedDistribution, '#8561FF');

  } catch (err) {
    clearInterval(poll);
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorMsg.textContent = err.message || t('holders.error');
  }
}
