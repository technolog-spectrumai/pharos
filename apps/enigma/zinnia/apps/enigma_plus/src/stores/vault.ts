import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type VaultFile, type VaultBucket } from "../services/api";

export const useVaultStore = defineStore("vault", () => {
  const files = ref<VaultFile[]>([]);
  const buckets = ref<VaultBucket[]>([]);
  const loading = ref(false);
  const uploading = ref(false);
  const error = ref<string | null>(null);
  const metrics = ref<any | null>(null);
  const metricsLoading = ref(false);

  async function fetchFiles() {
    loading.value = true;
    error.value = null;
    try {
      // Load the folder skeleton and the files in parallel; the tree overlays
      // files onto buckets/directories by bucket_slug + directory_id.
      const [filesRes, bucketsRes] = await Promise.all([
        api.getFiles(),
        api.getBuckets().catch(() => ({ buckets: [] as VaultBucket[] })),
      ]);
      files.value = filesRes.files;
      buckets.value = bucketsRes.buckets;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load files";
    } finally {
      loading.value = false;
    }
  }

  async function loadContent(key: string) {
    return api.getFileContent(key);
  }

  async function saveContent(key: string, content: string) {
    const vf = await api.saveFileContent(key, content);
    const idx = files.value.findIndex((f) => f.key === key);
    if (idx !== -1) files.value[idx] = vf;
    return vf;
  }

  async function upload(file: File, title?: string, bucketSlug?: string) {
    uploading.value = true;
    error.value = null;
    try {
      const vf = await api.uploadFile(file, title || file.name, bucketSlug);
      files.value.unshift(vf);
      return vf;
    } catch (e: any) {
      error.value = e.message ?? "Upload failed";
      throw e;
    } finally {
      uploading.value = false;
    }
  }

  async function createFile(bucketSlug: string, directoryId: number | null, title: string, fileType: string) {
    const vf = await api.createFile(bucketSlug, directoryId, title, fileType);
    files.value.unshift(vf);
    return vf;
  }

  async function rename(key: string, title: string) {
    const vf = await api.renameFile(key, title);
    const idx = files.value.findIndex((f) => f.key === key);
    if (idx !== -1) files.value[idx] = vf;
  }

  async function encrypt(key: string, password: string) {
    const vf = await api.encryptFile(key, password);
    const idx = files.value.findIndex((f) => f.key === key);
    if (idx !== -1) files.value[idx] = vf;
  }

  async function decrypt(key: string, password: string) {
    const vf = await api.decryptFile(key, password);
    const idx = files.value.findIndex((f) => f.key === key);
    if (idx !== -1) files.value[idx] = vf;
  }

  async function remove(key: string) {
    await api.deleteFile(key);
    files.value = files.value.filter((f) => f.key !== key);
  }

  async function fetchMetrics() {
    metricsLoading.value = true;
    try {
      metrics.value = await api.getVaultMetrics();
    } finally {
      metricsLoading.value = false;
    }
  }

  return { files, buckets, loading, uploading, error, metrics, metricsLoading, fetchFiles, loadContent, saveContent, createFile, upload, rename, encrypt, decrypt, remove, fetchMetrics };
});
