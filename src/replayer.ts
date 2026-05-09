import type { HTTPRequest, HTTPResponse, HTTPCassette, HTTPInteraction } from './types'
import { HTTPMatcher } from './matcher'

export class HTTPReplayer {
  private interactions: HTTPInteraction[] = []

  loadCassette(cassette: HTTPCassette): void {
    this.interactions.push(...cassette.interactions)
  }

  findResponse(request: HTTPRequest): HTTPResponse | null {
    const match = HTTPMatcher.findBestMatch(request, this.interactions)
    return match?.response ?? null
  }

  getInteractionCount(): number {
    return this.interactions.length
  }

  addInteraction(interaction: HTTPInteraction): void {
    this.interactions.push(interaction)
  }
}
