/** Work kinds accepted by the durable harness. */
export type WorkKind = "user_turn" | "cron_run" | "subagent_run" | "maintenance";

/** Durable work lifecycle states. */
export type WorkStatus = "queued" | "leased" | "completed" | "failed" | "cancelled";

/** Lease metadata for in-progress work. */
export interface WorkLease {
  /** Stable lease id. */
  id: string;
  /** Host/process that owns the lease. */
  ownerId: string;
  /** ISO timestamp when the lease was acquired. */
  leasedAt: string;
}

/** One durable work item. */
export interface WorkItem {
  /** Stable work id. */
  id: string;
  /** Work kind. */
  kind: WorkKind;
  /** Session this work belongs to. */
  sessionId: string;
  /** Adapter-owned payload. */
  payload: unknown;
  /** Lifecycle status. */
  status: WorkStatus;
  /** ISO timestamp when work was created. */
  createdAt: string;
  /** ISO timestamp when work was last updated. */
  updatedAt: string;
  /** ISO timestamp when queued work may be leased. */
  availableAt: string;
  /** Number of lease attempts. */
  attempts: number;
  /** Current lease for leased work. */
  lease?: WorkLease;
  /** Terminal failure reason. */
  failure?: string;
}

/** Leased work item with lease metadata present. */
export type LeasedWorkItem = WorkItem & {
  status: "leased";
  lease: WorkLease;
};

/** Work submission input. */
export interface SubmitWorkInput {
  /** Optional caller-owned id. */
  id?: string;
  /** Work kind. */
  kind: WorkKind;
  /** Session this work belongs to. */
  sessionId: string;
  /** Adapter-owned payload. */
  payload: unknown;
  /** Earliest lease time. */
  availableAt?: Date;
}

/** Lease request options. */
export interface LeaseWorkOptions {
  /** Host/process requesting the lease. */
  ownerId: string;
  /** Optional work kind filter. */
  kinds?: readonly WorkKind[];
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Completion options. */
export interface CompleteWorkOptions {
  /** Current lease id. */
  leaseId: string;
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Release options for returning leased work to the queue. */
export interface ReleaseWorkOptions extends CompleteWorkOptions {
  /** Earliest future lease time. Defaults to now. */
  availableAt?: Date;
}

/** Failure options. */
export interface FailWorkOptions extends CompleteWorkOptions {
  /** Failure reason. */
  reason: string;
}

/** Cancellation options. */
export interface CancelWorkOptions {
  /** Cancellation reason. */
  reason: string;
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Interrupted work recovery options. */
export interface RecoverInterruptedWorkOptions {
  /** Current time. */
  now?: Date;
  /** Maximum lease attempts before failing a work item. */
  maxAttempts: number;
}

/** Interrupted work recovery result. */
export interface RecoverInterruptedWorkResult {
  /** Work ids moved back to queued. */
  requeued: string[];
  /** Work ids failed because attempts were exhausted. */
  failed: string[];
}

/** Durable work-listing options. */
export interface ListWorkOptions {
  /** Optional kind filter. */
  kind?: WorkKind;
  /** Optional session filter. */
  sessionId?: string;
  /** Optional status filter. */
  statuses?: readonly WorkStatus[];
}

/** Durable queue port. */
export interface WorkQueue {
  /** Submits work to the durable queue. */
  submit(input: SubmitWorkInput): Promise<WorkItem>;
  /** Returns a work item by id. */
  get(id: string): Promise<WorkItem | null>;
  /** Leases a specific due queued work item by id. */
  lease(id: string, options: LeaseWorkOptions): Promise<LeasedWorkItem | null>;
  /** Leases the next available work item. */
  leaseNext(options: LeaseWorkOptions): Promise<LeasedWorkItem | null>;
  /** Marks leased work completed. */
  complete(id: string, options: CompleteWorkOptions): Promise<void>;
  /** Returns leased work to queued state. */
  release(id: string, options: ReleaseWorkOptions): Promise<void>;
  /** Marks leased work failed. */
  fail(id: string, options: FailWorkOptions): Promise<void>;
  /** Cancels queued or leased work. */
  cancel(id: string, options: CancelWorkOptions): Promise<void>;
  /** Recovers interrupted leased work after restart or host failure. */
  recoverInterruptedWork(options: RecoverInterruptedWorkOptions): Promise<RecoverInterruptedWorkResult>;
  /** Lists durable work items. */
  listWork(options?: ListWorkOptions): Promise<WorkItem[]>;
}
