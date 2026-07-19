(function() {
  'use strict';

  // Wait for page load
  function init() {
    // Find the main image (largest one on page)
    const images = Array.from(document.querySelectorAll('img'));
    const mainImg = images.reduce((prev, curr) => 
      (curr.naturalWidth * curr.naturalHeight) > (prev.naturalWidth * prev.naturalHeight) 
        ? curr : prev
    , { naturalWidth: 0, naturalHeight: 0 });

    if (!mainImg.src) return;

    // Create button container
    const btnContainer = document.createElement('div');
    btnContainer.className = 'simple-img-buttons';
    
    // View Button
    const viewBtn = document.createElement('button');
    viewBtn.textContent = '👁️ View Image';
    viewBtn.onclick = () => window.open(mainImg.src, '_blank');
    
    // Download Button
    const dlBtn = document.createElement('button');
    dlBtn.textContent = '⬇️ Download Image';
    dlBtn.onclick = async () => {
      try {
        const resp = await fetch(mainImg.src);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const ext = mainImg.src.split('.').pop().split('?')[0] || 'jpg';
        
        chrome.runtime.sendMessage({
          action: 'download',
          url: url,
          filename: `image_${Date.now()}.${ext}`,
          saveAs: true
        });
        
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) {
        // Fallback direct download
        const a = document.createElement('a');
        a.href = mainImg.src;
        a.download = `image_${Date.now()}.jpg`;
        a.click();
      }
    };

    btnContainer.appendChild(viewBtn);
    btnContainer.appendChild(dlBtn);
    
    // Insert after the main image
    mainImg.parentNode.insertBefore(btnContainer, mainImg.nextSibling);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 500);
  }
})();