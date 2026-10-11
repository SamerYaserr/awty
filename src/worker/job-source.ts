export interface JobRef {
  id: string;
  retryCount: number;
}

export interface FetchedJob extends JobRef {
  data: { taskId: string };
}

export interface JobSource {
  fetch(batchSize: number): Promise<FetchedJob[]>;

  complete(job: JobRef): Promise<boolean>;

  fail(jobs: readonly JobRef[], reason: string): Promise<void>;

  touch(jobs: readonly JobRef[]): Promise<Set<string> | null>;
}

export const JOB_SOURCE = Symbol('JOB_SOURCE');
