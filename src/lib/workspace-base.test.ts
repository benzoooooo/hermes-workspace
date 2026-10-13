import { describe, expect, it } from 'vitest'
import {
  browserShimSource,
  cookiePath,
  normalizeWorkspaceBase,
  prefixRootUrl,
  prefixSameOriginUrl,
  stripWorkspaceBase,
  viteBase,
} from './workspace-base.mjs'

describe('workspace base', () => {
  it('keeps the origin root when the base is unset', () => {
    expect(normalizeWorkspaceBase(undefined)).toBe('')
    expect(normalizeWorkspaceBase('/')).toBe('')
    expect(viteBase('/')).toBe('/')
    expect(cookiePath('/')).toBe('/')
    expect(prefixRootUrl('/', '/api/sessions')).toBe('/api/sessions')
    expect(stripWorkspaceBase('/', '/api/sessions')).toBe('/api/sessions')
  })

  it('prefixes only root-relative urls and strips them back', () => {
    expect(prefixRootUrl('/hermes', '/api/events')).toBe('/hermes/api/events')
    expect(prefixRootUrl('/hermes/', '/api/events')).toBe('/hermes/api/events')
    expect(prefixRootUrl('/hermes', '/hermes/api/events')).toBe('/hermes/api/events')
    expect(prefixRootUrl('/hermes', 'https://example.test/api/events')).toBe(
      'https://example.test/api/events',
    )
    expect(prefixRootUrl('/hermes', '//cdn.example/app.js')).toBe('//cdn.example/app.js')
    expect(prefixRootUrl('/hermes', 'sessions')).toBe('sessions')
    expect(stripWorkspaceBase('/hermes', '/hermes/assets/app.js')).toBe('/assets/app.js')
    expect(stripWorkspaceBase('/hermes', '/hermes')).toBe('/')
    expect(stripWorkspaceBase('/hermes', '/api/chat/completions')).toBe(
      '/api/chat/completions',
    )
  })

  it('rewrites same-origin absolute urls and leaves other origins', () => {
    expect(
      prefixSameOriginUrl(
        '/hermes',
        'https://myai.awg.ru/api/events',
        'https://myai.awg.ru',
      ),
    ).toBe('https://myai.awg.ru/hermes/api/events')
    expect(
      prefixSameOriginUrl(
        '/hermes',
        'https://agent.example/health',
        'https://myai.awg.ru',
      ),
    ).toBe('https://agent.example/health')
  })

  it('emits a no-op browser shim when the app is mounted at the root', () => {
    expect(browserShimSource('/')).toContain('if (!base) return;')
    expect(browserShimSource('/hermes')).toContain('"/hermes"')
    expect(browserShimSource('/hermes')).toContain('HTMLImageElement')
    expect(cookiePath('/hermes/')).toBe('/hermes')
    expect(viteBase('/hermes')).toBe('/hermes/')
  })
})
