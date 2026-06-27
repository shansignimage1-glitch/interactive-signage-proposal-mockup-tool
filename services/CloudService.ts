
import { CloudProvider, SignTemplate } from '../types';

// This service abstracts the API calls for Google Drive, Dropbox, and OneDrive.
// In a production environment, this would handle OAuth flows and use the respective SDKs (GAPI, Dropbox Chooser, OneDrive Picker).

export const CloudService = {
  
  importFromProvider: async (provider: CloudProvider): Promise<SignTemplate | null> => {
    console.log(`Initiating import from ${provider}...`);
    
    return new Promise((resolve, reject) => {
      // Simulate the async nature of opening a file picker and downloading a file
      setTimeout(() => {
        
        // Mock success response
        // In a real implementation, this would return the file data selected by the user
        const mockFile: SignTemplate = {
          id: `cloud-${Date.now()}`,
          name: `Imported from ${formatProviderName(provider)}`,
          category: 'Cloud Asset',
          width: 2000,
          height: 500,
          image: getMockImageForProvider(provider)
        };
        
        resolve(mockFile);
      }, 1500);
    });
  }
};

const formatProviderName = (p: CloudProvider) => {
  switch(p) {
    case 'google_drive': return 'Google Drive';
    case 'dropbox': return 'Dropbox';
    case 'onedrive': return 'OneDrive';
  }
};

const getMockImageForProvider = (p: CloudProvider) => {
    // Returns a placeholder image representing a file fetched from that service
    switch(p) {
        case 'google_drive': return 'https://placehold.co/2000x500/4285F4/FFF?text=FROM+GOOGLE+DRIVE';
        case 'dropbox': return 'https://placehold.co/2000x500/0061FF/FFF?text=FROM+DROPBOX';
        case 'onedrive': return 'https://placehold.co/2000x500/0078D4/FFF?text=FROM+ONEDRIVE';
    }
    return '';
};
