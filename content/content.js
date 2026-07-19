// Simple inline buttons injected near the blue action button
(function () {
  'use strict';

  let buttonsInjected = false;

  function injectButtons() {
    if (buttonsInjected) return;

    // Find the container with the blue "செல் >" button
    // Adjust selector based on actual DOM structure
    const actionContainer = document.querySelector('div[style*="flex"], .action-bar, .button-row, footer') 
      || document.body;

    // Create wrapper for our buttons
    const btnWrapper = document.createElement('div');
    btnWrapper.id = 'ivp-buttons';
    btnWrapper.style.cssText = `
      display: flex;
      gap: 8px;
      margin-top: 10px;
      align-items: center;
    `;

    // View Image Button
    const viewBtn = document.createElement('button');
    viewBtn.textContent = '👁️ View Image';
    viewBtn.style.cssText = `
      padding: 8px 16px;
      background: #4a90d9;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      font-weight: 500;
    `;

    // Download Image Button
    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = '⬇️ Download Image';
    downloadBtn.style.cssText = `
      padding: 8px 16px;
      background: #2ecc71;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      font-weight: 500;
    `;

    // Get the largest image on the page
    function getMainImage() {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.reduce((prev, curr) => 
        (curr.naturalWidth * curr.naturalHeight) > (prev.naturalWidth * prev.naturalHeight) 
          ? curr : prev
      , imgs[0] || null);
    }

    // View Image handler - opens in new tab
    viewBtn.addEventListener('click', () => {
      const img = getMainImage();
      if (img) {
        window.open(img.src, '_blank');
      } else {
        alert('No image found on this page.');
      }
    });

    // Download Image handler - triggers Save As
    downloadBtn.addEventListener('click', async () => {
      const img = getMainImage();
      if (!img) {
        alert('No image found on this page.');
        return;
      }

      try {
        const response = await fetch(img.src);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        
        const ext = img.src.split('.').pop().split('?')[0] || 'jpg';
        const filename = `image_${Date.now()}.${ext}`;

        chrome.runtime.sendMessage({
          action: 'download',
          url: url,
          filename: filename,
          saveAs: true
        }, () => {
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        });
      } catch (err) {
        console.error('Download failed:', err);
        // Fallback: direct link download
        const a = document.createElement('a');
        a.href = img.src;
        a.download = `image_${Date.now()}.jpg`;
        a.target = '_blank';
        a.click();
      }
    });

    btnWrapper.appendChild(viewBtn);
    btnWrapper.appendChild(downloadBtn);
    actionContainer.appendChild(btnWrapper);
    buttonsInjected = true;
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButtons);
  } else {
    setTimeout(injectButtons, 1000);
  }

})();