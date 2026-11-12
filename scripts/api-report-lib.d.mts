export interface ApiReportOptions {
  readonly reportFolder: string;
  readonly tempFolder: string;
  readonly update?: boolean;
}

export interface ApiReportResult {
  readonly name: string;
  readonly reportFile: string;
  readonly changed: boolean;
  readonly ok: boolean;
  readonly errorCount: number;
}

export function reportFileName(packageName: string): string;
export function checkApiReport(projectFolder: string, options: ApiReportOptions): ApiReportResult;
