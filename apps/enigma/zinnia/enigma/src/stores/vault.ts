import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type VaultFile } from "../services/api";

export const useVaultStore = defineStore("vault", () => {
  const files = ref<VaultFile[]>([]);
  const loading = ref(false);
  const uploading = ref(false);
  const error = ref<string | null>(null);

  async function fetchFiles() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.getFiles();
      files.value = res.files;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load files";
    } finally {
      loading.value = false;
    }
  }

  async function upload(file: File, title?: string) {
    uploading.value = true;
    error.value = null;
    try {
      const vf = await api.uploadFile(file, title || file.name);
      files.value.unshift(vf);
      return vf;
    } catch (e: any) {
      error.value = e.message ?? "Upload failed";
      throw e;
    } finally {
      uploading.value = false;
    }
  }

  async function remove(key: string) {
    await api.deleteFile(key);
    files.value = files.value.filter((f) => f.key !== key);
  }

  return { files, loading, uploading, error, fetchFiles, upload, remove };
});
