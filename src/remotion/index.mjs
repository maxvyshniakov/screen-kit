import { registerRoot } from 'remotion';
import { RemotionRoot, COMPOSITION_ID, calculateTimelineMetadata } from './Root.mjs';
import { TimelineComposition } from './TimelineComposition.mjs';

registerRoot(RemotionRoot);

export { RemotionRoot, TimelineComposition, COMPOSITION_ID, calculateTimelineMetadata };
