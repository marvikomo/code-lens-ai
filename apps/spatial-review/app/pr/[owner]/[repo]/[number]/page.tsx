import { SpatialCanvas } from "@/components/SpatialCanvas";

/**
 * Spatial canvas route. Currently always renders the hardcoded PR #10330
 * fixture — Day 3 wires the route params to a real backend fetch.
 *
 * URL shape: /pr/langchain-ai/langchainjs/10330
 */
export default function PrPage() {
  return <SpatialCanvas />;
}
