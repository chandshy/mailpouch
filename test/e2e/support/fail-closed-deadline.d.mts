export interface FailClosedDeadlineOptions {
  deadline: number;
  label: string;
  closeConnection(): void;
  report(message: string): void;
  terminate(code: number): void;
}

export interface FailClosedDeadline {
  readonly deadline: number;
  readonly label: string;
  readonly expired: boolean;
  expire(): void;
  expireIfDue(): boolean;
  clear(): void;
}

export function beginFailClosedDeadline(options: FailClosedDeadlineOptions): FailClosedDeadline;
