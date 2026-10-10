export async function readPromptResponse(response) {
    try {
        const result = await response.json();
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid response object.");
        return result;
    } catch {
        const unavailable = response.status === 404 || response.status === 405;
        const error = new Error(unavailable
            ? `Prompt Designer backend routes are unavailable (HTTP ${response.status}). Check the ComfyUI startup log for API registration errors.`
            : `Invalid JSON response from Prompt Designer (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
    }
}
