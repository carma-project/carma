// Pluggable fine-tune provider contract. Companies bring their own model
// provider by implementing this interface; CARMA ships a `local` (offline)
// provider and a `fireworks` provider.

export interface SubmitInput {
  datasetJsonl: string;
  count: number;
  baseModel: string;
  suffix?: string;
  meta?: Record<string, any>;
}

export interface JobResult {
  provider: string;
  jobId: string;
  status: string;
  model?: string;
  datasetId?: string;
  [k: string]: any;
}

export interface FineTuneProvider {
  name: string;
  submit(input: SubmitInput): Promise<JobResult>;
  status(jobId: string): Promise<JobResult>;
}
