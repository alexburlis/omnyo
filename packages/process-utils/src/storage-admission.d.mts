export type StorageAdmissionRequest = {
  directory: string;
  expectedBytes: number;
  minimumFreeBytes: number;
};

export type StorageAdmission = StorageAdmissionRequest & {
  filesystemDirectory: string;
  availableBytes: number;
  requiredBytes: number;
};

export function assertStorageAdmission(
  request: StorageAdmissionRequest,
): Promise<StorageAdmission>;
