/**
 * dsh-cost-kline — 浏览器侧。
 *
 * 这是一个「普通副作用脚本」：不许有顶层 import/export，必须通过
 * window.__ModuleLoader__.load({ id, factory }) 注册自己。
 * React 由 require('react') 取得。
 *
 * 数据来自 Host 侧注册的同源路由 /dsh-cost-kline/state（轮询）。
 */
;(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return

  var NAME = 'dsh-cost-kline'
  var STORAGE_KEY = 'dsh-cost-kline:ui'
  var POLL_MS = 2500
  var INTERVALS = [
    { label: '1分', ms: 60000 },
    { label: '3分', ms: 180000 },
    { label: '5分', ms: 300000 },
    { label: '15分', ms: 900000 },
    { label: '1时', ms: 3600000 },
  ]

  window.__ModuleLoader__.load({
    id: NAME,
    factory: function (require) {
      var React = require('react')
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useRef = React.useRef
      var useMemo = React.useMemo
      var useCallback = React.useCallback

      /* ------------------------------- 工具函数 ------------------------------- */

      function loadUi() {
        try {
          var raw = window.localStorage.getItem(STORAGE_KEY)
          var parsed = raw ? JSON.parse(raw) : {}
          return parsed && typeof parsed === 'object' ? parsed : {}
        } catch (e) {
          return {}
        }
      }

      function saveUi(patch) {
        try {
          var next = Object.assign({}, loadUi(), patch)
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        } catch (e) {
          /* 隐私模式下忽略 */
        }
      }

      function money(v) {
        var n = typeof v === 'number' && isFinite(v) ? v : 0
        if (n !== 0 && Math.abs(n) < 0.01) return n.toFixed(4)
        if (Math.abs(n) < 1) return n.toFixed(3)
        return n.toFixed(2)
      }

      function compact(n) {
        var v = typeof n === 'number' && isFinite(n) ? n : 0
        if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
        return String(Math.round(v))
      }

      function clock(ts) {
        var d = new Date(ts)
        var hh = String(d.getHours()).padStart(2, '0')
        var mm = String(d.getMinutes()).padStart(2, '0')
        return hh + ':' + mm
      }

      function dayClock(ts) {
        var d = new Date(ts)
        return String(d.getMonth() + 1) + '/' + String(d.getDate()) + ' ' + clock(ts)
      }

      /** 从样本构造「每分钟花费」格子，再按 bucketMs 聚合成 K 线柱。 */
      function buildCandles(samples, bucketMs, maxBuckets) {
        var minutes = new Map()
        for (var i = 0; i < samples.length; i += 1) {
          var s = samples[i]
          if (!s || typeof s[0] !== 'number') continue
          var key = Math.floor(s[0] / 60000) * 60000
          var cell = minutes.get(key)
          if (!cell) {
            cell = { cost: 0, tokens: 0, hit: 0, miss: 0 }
            minutes.set(key, cell)
          }
          cell.cost += s[1] || 0
          cell.tokens += s[2] || 0
          cell.hit += s[3] || 0
          cell.miss += s[4] || 0
        }
        if (minutes.size === 0) return []
        var keys = Array.from(minutes.keys()).sort(function (a, b) {
          return a - b
        })
        var lastMinute = keys[keys.length - 1]
        var perBucket = Math.max(1, Math.round(bucketMs / 60000))
        var lastBucket = Math.floor(lastMinute / bucketMs) * bucketMs
        // 历史不足时不要画满 52 个空槽：窗口收缩到实际跨度（至少 10 槽，柱子不至于过宽）。
        var firstKeyBucket = Math.floor(keys[0] / bucketMs) * bucketMs
        var span = Math.floor((lastBucket - firstKeyBucket) / bucketMs) + 1
        maxBuckets = Math.min(maxBuckets, Math.max(10, span))
        var firstBucket = lastBucket - (maxBuckets - 1) * bucketMs
        var out = []
        for (var b = 0; b < maxBuckets; b += 1) {
          var start = firstBucket + b * bucketMs
          var cells = []
          for (var k = 0; k < perBucket; k += 1) {
            var c = minutes.get(start + k * 60000)
            if (c) cells.push(c)
          }
          if (cells.length === 0) {
            out.push({ t: start, empty: true })
            continue
          }
          var high = -Infinity
          var low = Infinity
          var cost = 0
          var tokens = 0
          var hit = 0
          var miss = 0
          for (var j = 0; j < cells.length; j += 1) {
            var cell = cells[j]
            if (cell.cost > high) high = cell.cost
            if (cell.cost < low) low = cell.cost
            cost += cell.cost
            tokens += cell.tokens
            hit += cell.hit
            miss += cell.miss
          }
          out.push({
            t: start,
            open: cells[0].cost,
            close: cells[cells.length - 1].cost,
            high: high,
            low: low,
            cost: cost,
            tokens: tokens,
            hit: hit,
            miss: miss,
          })
        }
        return out
      }

      function niceMax(v) {
        if (!(v > 0)) return 0.01
        var exp = Math.floor(Math.log10(v))
        var base = Math.pow(10, exp)
        var n = v / base
        var mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
        return mult * base
      }

      var UP = '#f6465d'
      var DOWN = '#0ecb81'
      var FLAT = '#8b8f9a'

      // 主题：DSH 在深色方案下给 body 打 data-ds-dark-theme
      function isDark() {
        try {
          return !!(document && document.body && document.body.hasAttribute('data-ds-dark-theme'))
        } catch (e) {
          return false
        }
      }

      function ink(dark, darkValue, lightValue) {
        return dark ? darkValue : lightValue
      }

      /* --------------------------------- 样式 --------------------------------- */

      var CSS = [
        '.ck-panel{position:fixed;z-index:2147483000;width:330px;box-sizing:border-box;',
        'border-radius:14px;padding:0;overflow:hidden;',
        'background:linear-gradient(180deg,rgba(24,26,33,.97),rgba(16,17,22,.97));',
        'border:1px solid rgba(255,255,255,.09);',
        'box-shadow:0 18px 44px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.3);',
        'color:#e7e9ee;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;',
        'backdrop-filter:blur(12px);user-select:none}',
        '.ck-head{display:flex;align-items:center;gap:8px;padding:9px 10px;cursor:grab;',
        'background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,0));',
        'border-bottom:1px solid rgba(255,255,255,.07)}',
        '.ck-head:active{cursor:grabbing}',
        '.ck-title{font-weight:600;font-size:12px;letter-spacing:.2px;opacity:.92;flex:1;white-space:nowrap}',
        '.ck-dot{width:6px;height:6px;border-radius:50%;background:' + DOWN + ';box-shadow:0 0 6px ' + DOWN + ';flex:none}',
        '.ck-dot.ck-off{background:#6b7280;box-shadow:none}',
        '.ck-x{border:0;background:transparent;color:#9aa0ab;cursor:pointer;font-size:13px;line-height:1;padding:2px 3px;border-radius:4px}',
        '.ck-x:hover{background:rgba(255,255,255,.1);color:#e7e9ee}',
        '.ck-body{padding:9px 10px 10px}',
        '.ck-total{display:flex;align-items:baseline;gap:6px;margin-bottom:2px}',
        '.ck-total b{font-size:20px;font-weight:650;letter-spacing:-.3px;font-variant-numeric:tabular-nums}',
        '.ck-total span{font-size:11px;color:#8b93a1}',
        '.ck-cells{display:flex;gap:6px;margin:8px 0 6px}',
        '.ck-bal{display:flex;width:100%;box-sizing:border-box;align-items:center;gap:6px;margin:3px 0 2px;padding:3px 7px;border-radius:6px;background:#171b23;cursor:pointer;font-size:10.5px;color:#8b93a1;font-variant-numeric:tabular-nums}',
        '.ck-bal:hover{background:#1d222c}',
        '.ck-bal b{color:#e8ecf3;font-weight:600;font-size:11.5px}',
        '.ck-bal em{font-style:normal;color:#7f8797;border:1px solid #2a3140;border-radius:4px;padding:0 4px;font-size:9.5px;line-height:1.4}',
        '.ck-bal u{text-decoration:none;margin-left:auto;color:#6c7484}',
        '.ck-bal.ck-busy u{color:#e0b341}',        '.ck-cell{flex:1;background:rgba(255,255,255,.045);border-radius:8px;padding:5px 7px}',
        '.ck-cell i{display:block;font-style:normal;font-size:10px;color:#8b93a1;margin-bottom:1px}',
        '.ck-cell b{font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}',
        '.ck-tabs{display:flex;gap:4px;margin:4px 0 6px}',
        '.ck-tab{border:1px solid rgba(255,255,255,.1);background:transparent;color:#9aa0ab;',
        'border-radius:6px;padding:1.5px 6px;font-size:10.5px;cursor:pointer;line-height:1.5}',
        '.ck-tab:hover{color:#e7e9ee;border-color:rgba(255,255,255,.22)}',
        '.ck-tab.ck-on{background:rgba(80,160,255,.18);border-color:rgba(80,160,255,.5);color:#cfe4ff}',
        '.ck-foot{display:flex;justify-content:space-between;gap:6px;margin-top:6px;font-size:10px;color:#7d8493}',
        '.ck-tip{position:absolute;pointer-events:none;background:rgba(10,11,15,.96);border:1px solid rgba(255,255,255,.14);',
        'border-radius:6px;padding:4px 6px;font-size:10.5px;line-height:1.5;white-space:nowrap;z-index:2}',
        '.ck-empty{height:120px;display:flex;align-items:center;justify-content:center;color:#6f7683;font-size:11px}',
        '.ck-pill{position:fixed;z-index:2147483000;width:auto;border-radius:999px;padding:6px 11px;cursor:pointer;',
        'background:rgba(18,20,26,.94);border:1px solid rgba(255,255,255,.12);color:#e7e9ee;',
        'font:11.5px/1.4 -apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 8px 20px rgba(0,0,0,.4);',
        'display:flex;align-items:center;gap:6px;user-select:none}',
        '.ck-pill:hover{background:rgba(28,31,40,.96)}',
        '.ck-side{display:flex;flex-direction:column;gap:4px;margin:0 0 6px;padding:7px 8px 5px;',
        // 占满侧边栏：宿主把槽位塞进 flex 容器，不显式写满就会按内容宽度收缩
        'width:100%;min-width:0;box-sizing:border-box;align-self:stretch;',
        'border-radius:9px;background:rgba(0,0,0,.035);border:1px solid rgba(0,0,0,.07);',
        'font:11px/1.4 -apple-system,"Microsoft YaHei",sans-serif;color:#5f6672;overflow:hidden}',
        '.ck-side:hover{background:rgba(0,0,0,.055)}',
        '.ck-side-head{display:flex;align-items:center;gap:5px;font-size:10px;color:#6b7280}',
        '.ck-side-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:.2px}',
        '.ck-side-btn{border:0;background:transparent;color:#8a9099;cursor:pointer;font-size:11px;line-height:1;padding:2px 4px;border-radius:4px;flex:none}',
        '.ck-side-btn:hover{color:#1f2430;background:rgba(0,0,0,.07)}',
        '.ck-side-row{display:flex;align-items:baseline;gap:5px;font-variant-numeric:tabular-nums}',
        '.ck-side-row b{font-size:14.5px;font-weight:650;color:#1f2430;letter-spacing:-.2px}',
        '.ck-side-row i{font-style:normal;font-size:9.5px;color:#8a9099}',
        '.ck-side-bal{margin-left:auto;display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;color:#6b7280;flex:none}',
        '.ck-side-bal:hover{color:#1f2430}',
        '.ck-side-bal em{font-style:normal;color:#6b7280;border:1px solid rgba(0,0,0,.14);border-radius:4px;padding:0 3px;font-size:9px;line-height:1.4}',
        '.ck-side-chart{width:100%;overflow:hidden}',
        '.ck-side-chart .ck-empty{height:58px;font-size:10px;text-align:center;padding:0 4px}',
        '.ck-rail{border:0;background:transparent;color:#6b7280;cursor:pointer;width:100%;height:30px;font-size:15px;line-height:1;border-radius:6px;display:flex;align-items:center;justify-content:center}',
        '.ck-rail:hover{background:rgba(0,0,0,.07);color:#1f2430}',
        'body[data-ds-dark-theme] .ck-side{background:rgba(255,255,255,.035);border-color:rgba(255,255,255,.07);color:#9aa0ab}',
        'body[data-ds-dark-theme] .ck-side:hover{background:rgba(255,255,255,.055)}',
        'body[data-ds-dark-theme] .ck-side-head{color:#8b93a1}',
        'body[data-ds-dark-theme] .ck-side-btn{color:#7d8493}',
        'body[data-ds-dark-theme] .ck-side-btn:hover{color:#e7e9ee;background:rgba(255,255,255,.09)}',
        'body[data-ds-dark-theme] .ck-side-row b{color:#e7e9ee}',
        'body[data-ds-dark-theme] .ck-side-row i{color:#7d8493}',
        'body[data-ds-dark-theme] .ck-side-bal{color:#9aa0ab}',
        'body[data-ds-dark-theme] .ck-side-bal:hover{color:#e7e9ee}',
        'body[data-ds-dark-theme] .ck-side-bal em{color:#7f8797;border-color:#2a3140}',
        'body[data-ds-dark-theme] .ck-rail{color:#9aa0ab}',
        'body[data-ds-dark-theme] .ck-rail:hover{background:rgba(255,255,255,.08);color:#e7e9ee}',
      ].join('')

      var cssInstalled = false
      function installCss() {
        if (cssInstalled || typeof document === 'undefined') return
        var el = document.getElementById('dsh-cost-kline-style')
        if (!el) {
          el = document.createElement('style')
          el.id = 'dsh-cost-kline-style'
          document.head.appendChild(el)
        }
        // 热更新时旧样式表仍在 DOM 里：必须覆盖，否则新规则永远不生效
        if (el.textContent !== CSS) el.textContent = CSS
        cssInstalled = true
      }

      /* ------------------------------ 共享数据源 ------------------------------ */
      // 侧边栏卡片和浮窗面板挂在两个不同的 slot 树上，用模块级单例共享一份轮询，
      // 避免两边各拉一条 2.5s 的请求。

      var shared = { data: null, error: null, busy: false, listeners: [], timer: null }

      function emit() {
        var list = shared.listeners.slice()
        for (var i = 0; i < list.length; i += 1) list[i]()
      }

      function fetchState() {
        try {
          fetch('/dsh-cost-kline/state', { cache: 'no-store' })
            .then(function (r) {
              if (!r.ok) throw new Error('HTTP ' + r.status)
              return r.json()
            })
            .then(function (json) {
              shared.data = json
              shared.error = null
              emit()
            })
            .catch(function (e) {
              shared.error = e && e.message ? e.message : String(e)
              emit()
            })
        } catch (e) {
          shared.error = String(e)
          emit()
        }
      }

      function refreshBalance() {
        if (shared.busy) return
        shared.busy = true
        emit()
        fetch('/dsh-cost-kline/balance/refresh', { method: 'POST', cache: 'no-store' })
          .then(function (r) {
            return r.ok ? r.json() : null
          })
          .then(function (json) {
            if (json && shared.data) {
              shared.data = Object.assign({}, shared.data, { balance: json })
              emit()
            }
          })
          .catch(function () {})
          .then(function () {
            shared.busy = false
            emit()
          })
      }

      function useCostState() {
        var bump = useState(0)[1]
        useEffect(function () {
          var fn = function () {
            bump(function (n) {
              return n + 1
            })
          }
          shared.listeners.push(fn)
          if (!shared.timer) {
            fetchState()
            shared.timer = window.setInterval(fetchState, POLL_MS)
          }
          return function () {
            var idx = shared.listeners.indexOf(fn)
            if (idx >= 0) shared.listeners.splice(idx, 1)
            if (!shared.listeners.length && shared.timer) {
              window.clearInterval(shared.timer)
              shared.timer = null
            }
          }
        }, [])
        return { data: shared.data, error: shared.error, busy: shared.busy, refresh: refreshBalance }
      }

      function balanceView(data) {
        var bal = data && data.balance ? data.balance : null
        var view = { money: '查询中…', title: '余额来自 DSH 账号服务，点击刷新', tier: '' }
        if (bal && bal.ok && bal.wallets && bal.wallets.length) {
          view.money = bal.wallets
            .map(function (w) {
              return (w.currency === 'USD' ? '$' : '¥') + money(w.total)
            })
            .join(' ')
          view.title = bal.wallets
            .map(function (w) {
              return w.currency + '：充值 ' + money(w.toppedUp) + ' + 赠送 ' + money(w.granted)
            })
            .join('\n')
        } else if (bal && bal.pending) {
          view.money = '查询中…'
        } else if (bal && bal.ok === false) {
          view.money = '不可用'
          view.title = bal.error || '账号余额不可用'
        }
        if (bal && bal.tier) view.tier = bal.tier === 'off-peak' ? '谷时' : '峰时'
        return view
      }

      function computeMa(candles) {
        var closes = candles.map(function (c) {
          return c.empty ? null : c.close
        })
        return closes.map(function (v, i) {
          var sum = 0
          var count = 0
          for (var k = Math.max(0, i - 4); k <= i; k += 1) {
            if (closes[k] === null) continue
            sum += closes[k]
            count += 1
          }
          return count > 0 ? sum / count : null
        })
      }

      // 浮窗开关（侧边栏卡片控制，面板自己只读）
      var openState = { open: false, listeners: [] }

      function setOpen(next) {
        openState.open = next
        var list = openState.listeners.slice()
        for (var i = 0; i < list.length; i += 1) list[i]()
      }

      function useOpen() {
        var bump = useState(0)[1]
        useEffect(function () {
          var fn = function () {
            bump(function (n) {
              return n + 1
            })
          }
          openState.listeners.push(fn)
          return function () {
            var idx = openState.listeners.indexOf(fn)
            if (idx >= 0) openState.listeners.splice(idx, 1)
          }
        }, [])
        return openState.open
      }

      /* --------------------------------- 图表 --------------------------------- */

      function Chart(props) {
        var candles = props.candles
        var width = props.width
        var dark = isDark()
        var isCompact = props.compact === true
        var bodyH = props.bodyH || 132
        var volH = props.volH === 0 ? 0 : props.volH || 30
        var axisH = isCompact ? 0 : 14
        var padLeft = isCompact ? 27 : 34
        var padRight = 6
        var padTop = 6
        var gap = 8
        var plotW = width - padLeft - padRight
        var [hover, setHover] = useState(-1)

        var filled = candles.filter(function (c) {
          return !c.empty
        })

        var maxHigh = 0
        var maxTokens = 0
        for (var i = 0; i < candles.length; i += 1) {
          var c = candles[i]
          if (c.empty) continue
          if (c.high > maxHigh) maxHigh = c.high
          if (c.tokens > maxTokens) maxTokens = c.tokens
        }
        var top = niceMax(maxHigh * 1.15)

        var step = candles.length > 0 ? plotW / candles.length : plotW
        var bodyW = Math.max(1.6, Math.min(9, step * 0.62))

        function y(v) {
          if (top <= 0) return padTop + bodyH
          return padTop + bodyH - (v / top) * bodyH
        }

        var gridLines = [0, 0.25, 0.5, 0.75, 1]

        var nodes = []
        nodes.push(
          h(
            'svg',
            {
              width: width,
              height: padTop + bodyH + gap + volH + axisH,
              viewBox: '0 0 ' + width + ' ' + (padTop + bodyH + gap + volH + axisH),
              style: { display: 'block', overflow: 'visible' },
              onMouseLeave: function () {
                setHover(-1)
              },
            },
            gridLines.map(function (f, gi) {
              var yy = padTop + bodyH - f * bodyH
              var value = top * f
              return h(
                'g',
                { key: 'g' + gi },
                h('line', {
                  x1: padLeft,
                  x2: width - padRight,
                  y1: yy,
                  y2: yy,
                  stroke: ink(dark, 'rgba(255,255,255,.07)', 'rgba(0,0,0,.08)'),
                  strokeDasharray: f === 0 ? 'none' : '3 3',
                }),
                h(
                  'text',
                  {
                    x: padLeft - 5,
                    y: yy + 3,
                    textAnchor: 'end',
                    fill: ink(dark, '#767d8b', '#8a9099'),
                    fontSize: 8.5,
                    fontFamily: 'inherit',
                  },
                  money(value),
                ),
              )
            }),
            candles.map(function (c, idx) {
              var x = padLeft + idx * step + step / 2
              if (c.empty) return null
              var up = c.close > c.open
              var down = c.close < c.open
              var color = up ? UP : down ? DOWN : FLAT
              var yHigh = y(c.high)
              var yLow = y(c.low)
              var yOpen = y(c.open)
              var yClose = y(c.close)
              var bodyTop = Math.min(yOpen, yClose)
              var bodyBottom = Math.max(yOpen, yClose)
              var bodyHeight = Math.max(1, bodyBottom - bodyTop)
              var volTop = padTop + bodyH + gap
              var volBarH = maxTokens > 0 ? Math.max(1, (c.tokens / maxTokens) * volH) : 0
              return h(
                'g',
                {
                  key: 'c' + idx,
                  onMouseEnter: function () {
                    setHover(idx)
                  },
                },
                h('rect', {
                  x: padLeft + idx * step,
                  y: padTop,
                  width: step,
                  height: bodyH + gap + volH,
                  fill: hover === idx ? ink(dark, 'rgba(255,255,255,.05)', 'rgba(0,0,0,.04)') : 'transparent',
                }),
                h('line', {
                  x1: x,
                  x2: x,
                  y1: yHigh,
                  y2: yLow,
                  stroke: color,
                  strokeWidth: 1,
                }),
                h('rect', {
                  x: x - bodyW / 2,
                  y: bodyTop,
                  width: bodyW,
                  height: bodyHeight,
                  fill: up ? color : down ? color : 'transparent',
                  stroke: color,
                  strokeWidth: down ? 1 : 0,
                  opacity: 0.92,
                }),
                h('rect', {
                  x: x - bodyW / 2,
                  y: volTop + volH - volBarH,
                  width: bodyW,
                  height: volBarH,
                  fill: color,
                  opacity: 0.32,
                }),
              )
            }),
            props.ma.map(function (point, idx) {
              if (!point) return null
              var x = padLeft + idx * step + step / 2
              var previous = null
              for (var back = idx - 1; back >= 0; back -= 1) {
                if (props.ma[back]) {
                  previous = { x: padLeft + back * step + step / 2, y: y(props.ma[back]) }
                  break
                }
              }
              if (!previous) return null
              return h('line', {
                key: 'm' + idx,
                x1: previous.x,
                x2: x,
                y1: previous.y,
                y2: y(point),
                stroke: '#e0b341',
                strokeWidth: 1.2,
                opacity: 0.85,
                strokeLinecap: 'round',
              })
            }),
            (isCompact ? [] : (function () {
              var labels = []
              var count = candles.length
              var every = Math.max(1, Math.round(count / 5))
              for (var i2 = 0; i2 < count; i2 += every) {
                var cc = candles[i2]
                labels.push(
                  h(
                    'text',
                    {
                      key: 'x' + i2,
                      x: padLeft + i2 * step + step / 2,
                      y: padTop + bodyH + gap + volH + 11,
                      textAnchor: 'middle',
                      fill: ink(dark, '#6f7683', '#9aa0aa'),
                      fontSize: 8.5,
                      fontFamily: 'inherit',
                    },
                    clock(cc.t),
                  ),
                )
              }
              return labels
            })()),
          ),
        )

        var active = hover >= 0 ? candles[hover] : null
        var tooltip =
          active && !active.empty
            ? h(
                'div',
                {
                  className: 'ck-tip',
                  style: {
                    right: 6,
                    top: 4,
                  },
                },
                h('div', null, dayClock(active.t) + ' 起 ' + (props.intervalLabel || '')),
                h('div', null, '花费 ¥' + money(active.cost)),
                h('div', null, '速率 ' + money(active.open) + ' → ' + money(active.close) + ' ¥/分'),
                h('div', null, 'tokens ' + compact(active.tokens)),
              )
            : null

        return h(
          'div',
          { style: { position: 'relative' } },
          filled.length === 0
            ? h('div', { className: 'ck-empty' }, '还没有花费记录，跑一轮对话就会出现')
            : nodes,
          tooltip,
        )
      }

      /* --------------------------------- 面板 --------------------------------- */

      function Panel() {
        installCss()
        var open = useOpen()
        var initial = loadUi()
        var [collapsed, setCollapsed] = useState(initial.collapsed === true)
        var [bucketMs, setBucketMs] = useState(
          typeof initial.bucketMs === 'number' && initial.bucketMs >= 60000 ? initial.bucketMs : 180000,
        )
        var [pos, setPos] = useState(
          typeof initial.left === 'number' && typeof initial.top === 'number'
            ? { left: initial.left, top: initial.top }
            : null,
        )
        var posRef = useRef(pos)
        posRef.current = pos
        var dragRef = useRef(null)

        // 数据和余额都来自模块级单例，侧边栏卡片与浮窗共用同一条轮询
        var state = useCostState()
        var data = state.data
        var error = state.error
        var bv = balanceView(data)
        var balMoney = bv.money
        var balTitle = bv.title
        var tierText = bv.tier
        var balBusy = state.busy
        var refreshBalance = state.refresh

        // 首次挂载：给一个右下角的默认位置
        useEffect(function () {
          if (posRef.current) return
          var w = window.innerWidth
          var ht = window.innerHeight
          setPos({ left: Math.max(12, w - 330 - 20), top: Math.max(12, ht - 330 - 96) })
        }, [])

        // 拖拽：用 window 级监听，**不用 setPointerCapture**
        // （捕获会把后续 click 重定向到标题栏，标题栏上的 — / × 就永远收不到点击）
        var onPointerDown = useCallback(function (event) {
          if (event.button !== 0) return
          var target = event.target
          if (target && target.closest && target.closest('button')) return
          var start = posRef.current || { left: 0, top: 0 }
          var drag = { dx: event.clientX - start.left, dy: event.clientY - start.top }
          dragRef.current = drag
          function move(e) {
            var left = Math.min(Math.max(4, e.clientX - drag.dx), window.innerWidth - 80)
            var top = Math.min(Math.max(4, e.clientY - drag.dy), window.innerHeight - 46)
            setPos({ left: left, top: top })
          }
          function up() {
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', up)
            dragRef.current = null
            if (posRef.current) {
              saveUi({ left: Math.round(posRef.current.left), top: Math.round(posRef.current.top) })
            }
          }
          document.addEventListener('pointermove', move)
          document.addEventListener('pointerup', up)
        }, [])

        var onPointerMove = useCallback(function () {}, [])

        var onPointerUp = useCallback(function () {}, [])

        var candles = useMemo(
          function () {
            if (!data || !Array.isArray(data.samples)) return []
            return buildCandles(data.samples, bucketMs, 52)
          },
          [data, bucketMs],
        )

        var ma = useMemo(
          function () {
            return computeMa(candles)
          },
          [candles],
        )

        if (!open) return null

        var totals = (data && data.totals) || { all: 0, today: 0, hour: 0, tokens: 0, calls: 0, cacheHitRate: null }
        var intervalLabel =
          (INTERVALS.filter(function (i) {
            return i.ms === bucketMs
          })[0] || { label: '3分' }).label

        return h(
          'div',
          {
            className: 'ck-panel',
            style: pos ? { left: pos.left, top: pos.top } : { right: 20, bottom: 96 },
            onPointerMove: onPointerMove,
            onPointerUp: onPointerUp,
          },
          h(
            'div',
            { className: 'ck-head', onPointerDown: onPointerDown },
            h('div', { className: 'ck-dot' + (error ? ' ck-off' : '') }),
            h('div', { className: 'ck-title' }, '花费 K 线'),
            h(
              'button',
              {
                className: 'ck-x',
                title: collapsed ? '展开' : '收起',
                // 别让标题栏的拖拽捕获吞掉点击
                onPointerDown: function (e) {
                  e.stopPropagation()
                },
                onClick: function (e) {
                  e.stopPropagation()
                  setCollapsed(!collapsed)
                  saveUi({ collapsed: !collapsed })
                },
              },
              // ▢ 这类几何符号在部分字体里缺字形会显示成空框，用 + 更稳
              collapsed ? '+' : '—',
            ),
            h(
              'button',
              {
                className: 'ck-x',
                title: '关闭（收回到侧边栏）',
                onPointerDown: function (e) {
                  e.stopPropagation()
                },
                onClick: function (e) {
                  e.stopPropagation()
                  setOpen(false)
                },
              },
              '×',
            ),
          ),
          collapsed
            ? null
            : h(
                'div',
                { className: 'ck-body' },
                h(
                  'div',
                  { className: 'ck-total' },
                  h('b', null, '¥' + money(totals.all)),
                  h('span', null, '累计 · ' + (totals.calls || 0) + ' 次调用'),
                ),
                h(
                  'div',
                  {
                    className: 'ck-bal' + (balBusy ? ' ck-busy' : ''),
                    title: balTitle || '余额来自 DSH 账号服务，点击刷新',
                    onClick: refreshBalance,
                  },
                  h('i', null, '余额'),
                  h('b', null, balMoney),
                  tierText ? h('em', null, tierText) : null,
                  h('u', null, balBusy ? '…' : '↻'),
                ),
                h(
                  'div',
                  { className: 'ck-cells' },
                  h(
                    'div',
                    { className: 'ck-cell' },
                    h('i', null, '今日'),
                    h('b', null, '¥' + money(totals.today)),
                  ),
                  h(
                    'div',
                    { className: 'ck-cell' },
                    h('i', null, '近 1 小时'),
                    h('b', null, '¥' + money(totals.hour)),
                  ),
                  h(
                    'div',
                    { className: 'ck-cell' },
                    h('i', null, '缓存命中'),
                    h(
                      'b',
                      null,
                      totals.cacheHitRate === null || totals.cacheHitRate === undefined
                        ? '—'
                        : Math.round(totals.cacheHitRate * 100) + '%',
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'ck-tabs' },
                  INTERVALS.map(function (item) {
                    return h(
                      'button',
                      {
                        key: item.ms,
                        className: 'ck-tab' + (item.ms === bucketMs ? ' ck-on' : ''),
                        onClick: function () {
                          setBucketMs(item.ms)
                          saveUi({ bucketMs: item.ms })
                        },
                      },
                      item.label,
                    )
                  }),
                ),
                h(Chart, {
                  candles: candles,
                  ma: ma,
                  width: 310,
                  intervalLabel: intervalLabel,
                }),
                h(
                  'div',
                  { className: 'ck-foot' },
                  h('span', null, 'token ' + compact(totals.tokens)),
                  h(
                    'span',
                    null,
                    error ? '连接中断：' + error : data && data.note ? '估算值，非官方账单' : '等待数据…',
                  ),
                ),
              ),
        )
      }

      /* ------------------------------ 侧边栏卡片 ------------------------------ */

      // 挂在 `sidebar.footer.action`（list, root 作用域，位于侧边栏底部、Settings 之上）。
      // 宿主会传入 { wide }：侧边栏展开时渲染迷你 K 线，收起成 56px 轨道时只留一个图标。
      // 捕获渲染异常并直接显示在槽位里（DSH 的槽位边界会吞掉错误，必须自己兜住）
      var CardBoundary = (function () {
        function B(props) {
          React.Component.call(this, props)
          this.state = { err: null }
        }
        B.prototype = Object.create(React.Component.prototype)
        B.prototype.constructor = B
        B.getDerivedStateFromError = function (err) {
          return { err: err }
        }
        B.prototype.render = function () {
          if (this.state.err) {
            return h(
              'div',
              { style: { padding: '6px', fontSize: '10px', color: '#ff6b6b', wordBreak: 'break-all' } },
              'ck error: ' + (this.state.err && this.state.err.message ? this.state.err.message : String(this.state.err)),
            )
          }
          return this.props.children
        }
        return B
      })()

      function CardSlot(props) {
        return h(CardBoundary, null, h(SidebarCard, props))
      }

      function SidebarCard(props) {
        installCss()
        var wide = !(props && props.wide === false)
        var state = useCostState()
        var data = state.data
        var error = state.error
        var bv = balanceView(data)
        var totals = (data && data.totals) || { today: 0, all: 0, tokens: 0, calls: 0 }
        var boxRef = useRef(null)
        var [boxW, setBoxW] = useState(0)

        var candles = useMemo(
          function () {
            if (!data || !Array.isArray(data.samples)) return []
            return buildCandles(data.samples, 300000, 24)
          },
          [data],
        )
        var ma = useMemo(
          function () {
            return computeMa(candles)
          },
          [candles],
        )

        // 卡片宽度由侧边栏决定（264~420px），用 ResizeObserver 跟着走
        useEffect(
          function () {
            var node = boxRef.current
            if (!node) return
            if (typeof ResizeObserver === 'undefined') return
            var measure = function () {
              if (!node.isConnected) return
              var w = Math.floor(node.getBoundingClientRect().width)
              if (w > 0) setBoxW(w)
            }
            var ro = new ResizeObserver(measure)
            ro.observe(node)
            measure()
            // 侧边栏折叠/展开、窗口缩放都不一定触发 RO，再挂一层兜底
            window.addEventListener('resize', measure)
            var raf = requestAnimationFrame(measure)
            return function () {
              ro.disconnect()
              window.removeEventListener('resize', measure)
              cancelAnimationFrame(raf)
            }
          },
          [wide],
        )

        if (!wide) {
          return h(
            'button',
            {
              className: 'ck-rail',
              title: '花费 K 线 · 今日 ' + (error ? '连接中断' : '¥' + money(totals.today)),
              onClick: function () {
                setOpen(true)
              },
            },
            '💰',
          )
        }

        return h(
          'div',
          { className: 'ck-side' },
          h(
            'div',
            { className: 'ck-side-head' },
            h('span', { className: 'ck-dot' + (error ? ' ck-off' : '') }),
            h('span', { className: 'ck-side-title' }, '花费 K 线'),
            h(
              'button',
              {
                className: 'ck-side-btn',
                title: '展开详情',
                onClick: function () {
                  setOpen(true)
                },
              },
              '⤢',
            ),
          ),
          h(
            'div',
            { className: 'ck-side-row' },
            h('b', null, '¥' + money(totals.today)),
            h('i', null, '今日'),
            h(
              'span',
              {
                className: 'ck-side-bal',
                title: bv.title,
                onClick: state.refresh,
              },
              h('span', null, '余额 ' + bv.money),
              bv.tier ? h('em', null, bv.tier) : null,
            ),
          ),
          h(
            'div',
            { ref: boxRef, className: 'ck-side-chart' },
            boxW > 0
              ? h(Chart, {
                  candles: candles,
                  ma: ma,
                  width: boxW,
                  compact: true,
                  bodyH: 58,
                  volH: 14,
                  intervalLabel: '5分',
                })
              : null,
          ),
        )
      }

      /* -------------------------------- 注册 -------------------------------- */

      var inject = ['slots']

      function apply(ctx) {
        // 侧边栏底部常驻卡片（list 槽位，宿主传入 { wide }）
        ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'cost-kline',
              order: 100,
              registrant: 'dsh-cost-kline',
            },
            CardSlot,
          )
        })

        // 详情浮窗（默认收起，点卡片右上角 ⤢ 打开）
        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register(
            { name: 'shell.overlay', id: 'cost-kline', order: 1200, registrant: 'dsh-cost-kline' },
            Panel,
          )
        })
      }

      return { name: NAME, inject: inject, apply: apply }
    },
  })
})()
