import { Brand } from '../types';

export const BRANDS: Brand[] = [
  {
    id: 'coffee_co',
    name: 'Coffee Co.',
    logo: 'https://img.icons8.com/color/96/coffee-to-go.png',
    templates: [
        { 
            id: 'cc_fascia_3000', 
            name: 'Main Fascia (3m)', 
            category: 'Fascia', 
            width: 3000, 
            height: 600, 
            image: 'https://placehold.co/3000x600/3e2723/FFF?text=COFFEE+CO&font=montserrat' 
        },
        { 
            id: 'cc_fascia_small', 
            name: 'Entry Fascia (1.5m)', 
            category: 'Fascia', 
            width: 1500, 
            height: 400, 
            image: 'https://placehold.co/1500x400/3e2723/FFF?text=COFFEE&font=montserrat' 
        },
        { 
            id: 'cc_roundel', 
            name: 'Roundel Logo', 
            category: 'Projecting', 
            width: 800, 
            height: 800, 
            image: 'https://placehold.co/800x800/3e2723/FFF?text=CC&font=montserrat' 
        },
        { 
            id: 'cc_totem', 
            name: 'Drive-Thru Totem', 
            category: 'Totem', 
            width: 1200, 
            height: 4000, 
            image: 'https://placehold.co/1200x4000/3e2723/FFF?text=DRIVE+THRU&font=montserrat' 
        },
    ]
  },
  {
    id: 'tech_retail',
    name: 'Tech Retail',
    logo: 'https://img.icons8.com/color/96/mac-os.png',
    templates: [
        { 
            id: 'tr_fascia_main', 
            name: 'Storefront (5m)', 
            category: 'Fascia', 
            width: 5000, 
            height: 1000, 
            image: 'https://placehold.co/5000x1000/212121/FFF?text=TECH+RETAIL&font=roboto' 
        },
        { 
            id: 'tr_blade', 
            name: 'Blade Sign', 
            category: 'Projecting', 
            width: 600, 
            height: 600, 
            image: 'https://placehold.co/600x600/212121/FFF?text=TR&font=roboto' 
        },
        { 
            id: 'tr_window', 
            name: 'Window Vinyl', 
            category: 'Window', 
            width: 1000, 
            height: 1500, 
            image: 'https://placehold.co/1000x1500/transparent/000?text=SALE&font=roboto' 
        },
    ]
  },
  {
      id: 'burger_joint',
      name: 'Burger Joint',
      logo: 'https://img.icons8.com/color/96/hamburger.png',
      templates: [
          { id: 'bj_logo', name: 'Burger Logo', category: 'Fascia', width: 1000, height: 1000, image: 'https://placehold.co/1000x1000/ff9800/333?text=BURGER&font=anton' },
          { id: 'bj_text', name: 'Text Only', category: 'Fascia', width: 2500, height: 400, image: 'https://placehold.co/2500x400/transparent/d84315?text=BEST+BURGERS&font=anton' }
      ]
  }
];