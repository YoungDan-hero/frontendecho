import type { HTTPRequest, HTTPInteraction } from './types'

export class HTTPMatcher {
  static findBestMatch(
    request: HTTPRequest,
    interactions: HTTPInteraction[],
  ): HTTPInteraction | null {
    for (const interaction of interactions) {
      if (
        request.method === interaction.request.method &&
        HTTPMatcher.urlMatches(request.url, interaction.request.url)
      ) {
        return interaction
      }
    }
    return null
  }

  static urlMatches(url: string, pattern: string | RegExp): boolean {
    if (pattern instanceof RegExp) {
      return pattern.test(url)
    }
    if (url === pattern) return true
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$',
      )
      return regex.test(url)
    }
    return url.includes(pattern)
  }
}
