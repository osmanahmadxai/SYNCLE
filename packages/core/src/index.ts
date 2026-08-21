/**
 * web-safe entry point: types, error classes, and validation schemas only.
 * importing this never pulls in a native database driver, so it's safe for the
 * browser bundle. server code that needs to open connections imports from
 * `@syncle/core/adapters` instead.
 */
export * from './adapters/types';
export * from './errors';
export * from './sql';
export * from './validation';
export * from './bridges';
export * from './workspace';
export * from './auth';

// type-only re-exports of the driver metadata (no driver implementations are
// pulled in, so this stays safe for the browser bundle)
export type {
  DriverInfo,
  DriverField,
  DriverDefinition,
} from './adapters/registry';

/* -------------------------------------------------------------------------- */
/* legacy aliases (transition)                                                */
/*                                                                            */
/* The domain was renamed: a "hook" is now a bridge, and a "run" is now a     */
/* job. These aliases keep the old export names working for out-of-tree      */
/* consumers during the transition. They will be removed in a future major    */
/* release — import the new names instead.                                    */
/* -------------------------------------------------------------------------- */
import type {
  Bridge,
  BridgeAuth,
  BridgeDelivery,
  BridgeDeliveryConfig,
  BridgeDestination,
  BridgeInputDTO,
  BridgeJob,
  BridgeJobStatus,
  BridgePreview,
  BridgePreviewDTO,
  BridgePreviewTarget,
  BridgeSource,
  BridgeTransformConfig,
  BridgeTrigger,
  StartJobDTO,
} from './bridges';
import {
  bridgeAuthSchema,
  bridgeDeliverySchema,
  bridgeDestinationSchema,
  bridgeInputSchema,
  bridgePreviewSchema,
  bridgeSourceSchema,
  bridgeTransformSchema,
  bridgeTriggerSchema,
  startJobSchema,
} from './bridges';

/** @deprecated use {@link Bridge} */
export type Hook = Bridge;
/** @deprecated use {@link BridgeJob} */
export type HookRun = BridgeJob;
/** @deprecated use {@link BridgeDelivery} */
export type HookDelivery = BridgeDelivery;
/** @deprecated use {@link BridgeJobStatus} */
export type HookRunStatus = BridgeJobStatus;
/** @deprecated use {@link BridgeSource} */
export type HookSource = BridgeSource;
/** @deprecated use {@link BridgeAuth} */
export type HookAuth = BridgeAuth;
/** @deprecated use {@link BridgeDestination} */
export type HookDestination = BridgeDestination;
/** @deprecated use {@link BridgeTransformConfig} */
export type HookTransformConfig = BridgeTransformConfig;
/** @deprecated use {@link BridgeDeliveryConfig} */
export type HookDeliveryConfig = BridgeDeliveryConfig;
/** @deprecated use {@link BridgeTrigger} */
export type HookTrigger = BridgeTrigger;
/** @deprecated use {@link BridgeInputDTO} */
export type HookInputDTO = BridgeInputDTO;
/** @deprecated use {@link BridgePreviewDTO} */
export type HookPreviewDTO = BridgePreviewDTO;
/** @deprecated use {@link BridgePreview} */
export type HookPreview = BridgePreview;
/** @deprecated use {@link BridgePreviewTarget} */
export type HookPreviewTarget = BridgePreviewTarget;
/** @deprecated use {@link StartJobDTO} */
export type StartRunDTO = StartJobDTO;

/** @deprecated use {@link bridgeSourceSchema} */
export const hookSourceSchema = bridgeSourceSchema;
/** @deprecated use {@link bridgeAuthSchema} */
export const hookAuthSchema = bridgeAuthSchema;
/** @deprecated use {@link bridgeDestinationSchema} */
export const hookDestinationSchema = bridgeDestinationSchema;
/** @deprecated use {@link bridgeTransformSchema} */
export const hookTransformSchema = bridgeTransformSchema;
/** @deprecated use {@link bridgeDeliverySchema} */
export const hookDeliverySchema = bridgeDeliverySchema;
/** @deprecated use {@link bridgeTriggerSchema} */
export const hookTriggerSchema = bridgeTriggerSchema;
/** @deprecated use {@link bridgeInputSchema} */
export const hookInputSchema = bridgeInputSchema;
/** @deprecated use {@link bridgePreviewSchema} */
export const hookPreviewSchema = bridgePreviewSchema;
/** @deprecated use {@link startJobSchema} */
export const startRunSchema = startJobSchema;
