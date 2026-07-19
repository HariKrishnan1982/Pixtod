let currentImage = null;
let menuVisible = false;

// Create floating menu
function createMenu() {
  const menu = document.createElement('div');
  menu.id = 'image-viewer-menu';
  menu.innerHTML = `
    <div class="menu-item" data-action="view">
      <span class="icon">👁️</span>
      <span>View Photo</span>
    </div>
    <div class="menu-item" data-action="download">
      <span class="icon">⬇️</span>
      <span>Download Image</span>
    </div>
  `;
  document.body.appendChild(menu);
  return menu;
}

// Create three-dots button
function createThreeDots(image) {
  const btn = document.createElement('button');
  btn.className = 'image-three-dots';
  btn.innerHTML = '⋮';
  btn.title = 'Image Options';
  
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(image, btn);
  });
  
  return btn;
}

// Show menu near image
function showMenu(image, triggerBtn) {
  hideMenu();
  
  currentImage = image;
  const menu = document.getElementById('image-viewer-menu');
  if (!menu) return;
  
  const rect = triggerBtn.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 5) + 'px';
  menu.classList.add('visible');
  menuVisible = true;
  
  // Add click handlers
  menu.querySelectorAll('.menu-item').forEach(item => {
    item.onclick = (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      if (action === 'view') {
        viewImage(image.src);
      } else if (action === 'download') {
        downloadImage(image.src, image.alt || 'image');
      }
      hideMenu();
    };
  });
}

// Hide menu
function hideMenu() {
  const menu = document.getElementById('image-viewer-menu');
  if (menu) {
    menu.classList.remove('visible');
    menuVisible = false;
  }
}

// View image in overlay
function viewImage(src) {
  const overlay = document.createElement('div');
  overlay.className = 'image-viewer-overlay';
  overlay.innerHTML = `
    <div class="viewer-close">×</div>
    <img src="${src}" class="viewer-image">
  `;
  
  overlay.querySelector('.viewer-close').onclick = () => {
    overlay.remove();
  };
  
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  };
  
  document.body.appendChild(overlay);
}

// Download image
async function downloadImage(url, filename) {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const objectURL = URL.createObjectURL(blob);
    
    chrome.runtime.sendMessage({
      action: 'download',
      url: objectURL,
      filename: filename + getFileExtension(url),
      saveAs: true
    });
    
    setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
  } catch (error) {
    console.error('Download error:', error);
  }
}

function getFileExtension(url) {
  const match = url.match(/\.(jpg|jpeg|png|gif|webp|svg)/i);
  return match ? match[0] : '.jpg';
}

// Process all images on page
function processImages() {
  const images = document.querySelectorAll('img');
  images.forEach(img => {
    if (!img.dataset.processed && img.offsetWidth > 50 && img.offsetHeight > 50) {
      img.dataset.processed = 'true';
      img.style.position = 'relative';
      
      const dots = createThreeDots(img);
      img.parentNode.insertBefore(dots, img.nextSibling);
    }
  });
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    createMenu();
    processImages();
  });
} else {
  createMenu();
  processImages();
}

// Watch for new images
const observer = new MutationObserver((mutations) => {
  let shouldProcess = false;
  mutations.forEach((mutation) => {
    if (mutation.addedNodes.length > 0) {
      shouldProcess = true;
    }
  });
  if (shouldProcess) {
    setTimeout(processImages, 500);
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Close menu on outside click
document.addEventListener('click', (e) => {
  if (menuVisible && !e.target.closest('#image-viewer-menu') && !e.target.closest('.image-three-dots')) {
    hideMenu();
  }
});