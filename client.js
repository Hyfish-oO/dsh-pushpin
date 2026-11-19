/**
 * Client half of the pin-window plugin.
 *
 * One pushpin in the Session header's right-aligned utilities. Every press
 * asks the Host to flip the OS window's topmost bit and reports what the
 * window actually says afterwards, so the button can never claim a state the
 * operating system refused.
 *
 * The button does not render at all where the Host cannot do the job (no
 * Windows), and every failure carries a sentence from the Host instead of a
 * raw error code.
 *
 * Order 100 keeps it after the shipped header buttons, whose order is the
 * default 0. Same-value flex order falls back to DOM order, so a value above
 * zero is the only way a slot entry can claim the right edge.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pushpin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const NS = 'dsh-pin'
    const STATE_ROUTE = 'dsh-pin/api/state'
    const TOGGLE_ROUTE = 'dsh-pin/api/toggle'
    const SLOT_ID = 'dsh-pushpin'
    const SLOT_ORDER = 100

    const EN = {
      pin: 'Pin window on top',
      unpin: 'Unpin window',
      working: 'Asking Windows…',
      failed: 'Could not change the window state',
    }
    const ZH = {
      pin: '窗口置顶',
      unpin: '取消置顶',
      working: '正在问 Windows…',
      failed: '改不动窗口状态',
    }

    // Every colour is a DSH theme token, with a neutral fallback for host
    // builds that rename or drop one. Nothing here picks a fixed palette.
    const CSS = [
      '.dpin-wrap{position:fixed;top:7px;right:146px;z-index:2147483000;',
      'display:inline-flex;align-items:center;pointer-events:none;',
      'user-select:none;-webkit-user-select:none;',
      'app-region:no-drag;-webkit-app-region:no-drag;}',
      '.dpin-wrap--inline{position:relative;top:auto;right:auto;z-index:auto;}',
      '.dpin-bubble{position:absolute;top:calc(100% + 6px);right:0;padding:4px 8px;',
      'border-radius:6px;font-size:11px;line-height:1.35;white-space:nowrap;',
      'pointer-events:none;z-index:50;',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary, #e5484d) 14%,transparent);',
      'color:var(--dsw-alias-state-error-primary, #e5484d);',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary, #e5484d) 35%,transparent);',
      'box-shadow:0 4px 12px rgb(0 0 0 / 12%);}',
      '.dpin-btn{pointer-events:auto;app-region:no-drag;-webkit-app-region:no-drag;',
      'width:28px;height:28px;display:flex;align-items:center;justify-content:center;',
      'border-radius:8px;border:1px solid transparent;background:transparent;padding:0;',
      'color:var(--dsw-alias-label-secondary, #9aa2b1);cursor:pointer;',
      'transition:background .12s ease,color .12s ease,border-color .12s ease,transform .1s ease;}',
      '.dpin-btn:hover{color:var(--dsw-alias-label-primary, #e8eaef);background:var(--dsw-alias-bg-layer-2, #2a2d35);',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-2, #2a2d35) 55%,transparent);}',
      '.dpin-btn:active{transform:scale(.94);}',
      '.dpin-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, #4d6bfe);outline-offset:1px;}',
      '.dpin-btn--on{color:var(--dsw-alias-brand-primary, #4d6bfe);',
      'border-color:var(--dsw-alias-brand-primary, #4d6bfe);background:var(--dsw-alias-bg-layer-2, #2a2d35);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary, #4d6bfe) 10%,transparent);}',
      '.dpin-btn--on:hover{background:var(--dsw-alias-bg-layer-2, #2a2d35);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary, #4d6bfe) 18%,transparent);',
      'color:var(--dsw-alias-brand-primary, #4d6bfe);border-color:var(--dsw-alias-brand-primary, #4d6bfe);}',
      '.dpin-btn--busy{opacity:.55;cursor:default;}',
      '.dpin-btn--error{color:var(--dsw-alias-state-error-primary, #e5484d);}',
    ].join('')

    function apiUrl(path) {
      if (typeof document === 'undefined' || !document.baseURI) return '/' + path
      try {
        return new URL(path, document.baseURI).pathname
      } catch {
        return '/' + path
      }
    }

    /** Lucide's `pin` glyph (ISC), drawn on its 24px grid. */
    function PinGlyph(props) {
      const on = props.pinned === true
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: on ? 2.2 : 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        h('path', { d: 'M12 17v5' }),
        h('path', {
          d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
        }),
      )
    }

    function PinButton(props) {
      const m = props.m
      const [supported, setSupported] = useState(true)
      const [pinned, setPinned] = useState(false)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [bubble, setBubble] = useState(null)

      useEffect(
        function () {
          let alive = true
          fetch(apiUrl(STATE_ROUTE), { cache: 'no-store' })
            .then(function (response) {
              return response.json()
            })
            .then(function (body) {
              if (!alive || !body) return
              setSupported(body.supported !== false)
              if (body.ok === true) setPinned(body.topmost === true)
              else if (body.message) setNotice(body.message)
            })
            .catch(function () {
              /* a dead route is not proof the platform is wrong; keep the
                 button so the user can press it and see the real error */
            })
          return function () {
            alive = false
          }
        },
        [],
      )

      const toggle = useCallback(
        function () {
          if (busy) return
          const previous = pinned
          setBusy(true)
          // Flip the glyph immediately; the reply below is the source of truth
          // and puts it back if Windows refused.
          setPinned(!previous)
          fetch(apiUrl(TOGGLE_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
            .then(function (response) {
              return response.json()
            })
            .then(function (body) {
              if (body && body.ok === true) {
                setPinned(body.topmost === true)
                setNotice(null)
              } else {
                setPinned(previous)
                setNotice((body && body.message) || m('failed'))
              }
            })
            .catch(function () {
              setPinned(previous)
              setNotice(m('failed'))
            })
            .then(function () {
              setBusy(false)
            })
        },
        [busy, pinned, m],
      )

      // A failure banner should not stay forever. The tooltip carries the
      // reason for a while; the bubble is the loud version and leaves sooner.
      useEffect(
        function () {
          if (!notice) {
            setBubble(null)
            return undefined
          }
          setBubble(notice)
          const hideBubble = setTimeout(function () {
            setBubble(null)
          }, 2000)
          const clearNotice = setTimeout(function () {
            setNotice(null)
          }, 6000)
          return function () {
            clearTimeout(hideBubble)
            clearTimeout(clearNotice)
          }
        },
        [notice],
      )

      if (!supported) return null

      const label = busy ? m('working') : pinned ? m('unpin') : m('pin')
      const className = ['dpin-btn', pinned ? 'dpin-btn--on' : '', busy ? 'dpin-btn--busy' : '', notice ? 'dpin-btn--error' : '']
        .filter(Boolean)
        .join(' ')

      return h(
        'div',
        { className: 'dpin-wrap' + (props.mode === 'header' ? ' dpin-wrap--inline' : '') },
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: className,
            title: notice ? label + ' — ' + notice : label,
            'aria-label': label,
            'aria-pressed': pinned,
            'aria-disabled': busy,
            onClick: toggle,
          },
          h(PinGlyph, { pinned: pinned }),
        ),
        bubble ? h('div', { className: 'dpin-bubble', role: 'status' }, bubble) : null,
      )
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { en: EN, zh: ZH })
      }, 'dsh-pin: dictionaries')

      const t = ctx.locale.bind(NS)
      const m = function (key) {
        try {
          const value = t(key)
          if (typeof value === 'string' && value !== '') return value
        } catch {
          /* fall through */
        }
        return EN[key] !== undefined ? EN[key] : key
      }

      // The frame-wide overlay puts the pin up in the title bar. A host build
      // that does not declare it gets the session header instead: lower, but
      // the same control, and still a real slot.
      let headerOff = null
      let overlaySeen = false

      const placeInHeader = function () {
        if (overlaySeen || headerOff) return
        try {
          ctx.slots.inject('conversation.session.header.utilities', function () {
            headerOff = ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: SLOT_ID,
                order: SLOT_ORDER,
                label: function () {
                  return m('pin')
                },
              },
              function () {
                return h(PinButton, { m: m, mode: 'header' })
              },
            )
            return headerOff
          })
        } catch (cause) {
          console.warn('[dsh-pin] no usable header slot in this host:', cause)
        }
      }

      try {
        ctx.slots.inject('shell.overlay', function () {
          overlaySeen = true
          if (typeof headerOff === 'function') {
            headerOff()
            headerOff = null
          }
          return ctx.slots.register(
            {
              name: 'shell.overlay',
              id: SLOT_ID,
              order: 90,
            },
            function () {
              return h(PinButton, { m: m, mode: 'overlay' })
            },
          )
        })
      } catch (cause) {
        console.warn('[dsh-pin] shell.overlay is unavailable in this host:', cause)
      }

      setTimeout(placeInHeader, 3000)
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply: apply,
    }
  },
})
