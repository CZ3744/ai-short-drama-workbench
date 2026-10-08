/**
 * B4 / Wave 2E — 一致性三件套: 一致性检查 + 参考图集组装
 */
export {
  computeClipSimilarity,
  computeClipSimilarityWithMeta,
  computePairwiseSimilarities,
  runConsistencyCheck,
  trainCharacterLoRA,
  type ConsistencyAsset,
  type PairwiseSimilarity,
  type ScatterPoint,
  type ConsistencyReport,
  type ClipSimilarityResult,
} from "./consistencyCheck";

export {
  buildReferenceSet,
  countReferenceImages,
  type ReferenceImageEntry,
  type ReferenceImageSource,
  type ReferenceMissingEntry,
  type BuiltReferenceSet,
  type ReferenceSetSummary,
  type CharacterRefInput,
  type SceneRefInput,
  type MoodBoardRefInput,
  type BuildReferenceSetInput,
} from "./referenceSet";
