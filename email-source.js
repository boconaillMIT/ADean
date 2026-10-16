// Original-message export shared by the pane and its tests.
(function (root) {
  const MAX_BYTES = 3000000;
  function filename(subject) {
    return 'Email - ' + String(subject || 'Fund notice').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').trim().slice(0, 80) + '.eml';
  }
  function exportMessage(item, requirements, expectedItemId) {
    if (!item || !expectedItemId || item.itemId !== expectedItemId) return Promise.reject(new Error('Read the source email again before saving its attachment.'));
    if (!requirements?.isSetSupported('Mailbox', '1.14') || typeof item.getAsFileAsync !== 'function') {
      return Promise.reject(new Error('This Outlook version cannot export the email. Upload a saved .eml below, or uncheck Store source email.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Email export timed out. Upload a saved .eml or try again.')), 10000);
      try {
        item.getAsFileAsync(result => {
          clearTimeout(timer);
          if (result.status !== 'succeeded' || typeof result.value !== 'string' || !result.value) {
            reject(new Error('Outlook could not export the email. Upload a saved .eml or try again.')); return;
          }
          if (result.value.length > MAX_BYTES / 3 * 4) { reject(new Error('The email is over 3 MB. Upload a smaller saved .eml or uncheck Store source email.')); return; }
          resolve({ fileName: filename(item.subject), data: result.value });
        });
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  function readUpload(file) {
    if (!file || !/\.eml$/i.test(file.name)) return Promise.reject(new Error('Choose an .eml email file.'));
    if (!file.size || file.size > MAX_BYTES) return Promise.reject(new Error('Choose an email file up to 3 MB.'));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ fileName: filename(file.name.replace(/\.eml$/i, '')), data: String(reader.result).split(',')[1] });
      reader.onerror = () => reject(new Error('Could not read the selected email file.'));
      reader.readAsDataURL(file);
    });
  }
  const api = { filename, exportMessage, readUpload };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AccountEmail = api;
})(typeof window !== 'undefined' ? window : {});
