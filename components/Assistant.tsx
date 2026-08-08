import React, { useState, useEffect, useRef } from 'react';
import { MessageCircle, X, Send, Mic, Volume2, VolumeX, Loader2, Sparkles, Bot, ChevronDown, User as UserIcon } from 'lucide-react';
import { askSignageAssistant, generateSpeech } from '../services/GeminiService';
import { notify } from '../services/toast';

interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
}

interface AssistantProps {
  isOpen?: boolean;
  setIsOpen?: (isOpen: boolean) => void;
}

const Assistant: React.FC<AssistantProps> = ({ isOpen: propIsOpen, setIsOpen: propSetIsOpen }) => {
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { id: 'init', role: 'model', text: 'Hi! I\'m your SignagePro guide. Need help creating a mockup? Just ask or say "Teach me how to start"!' }
  ]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const isOpen = propIsOpen !== undefined ? propIsOpen : internalIsOpen;
  const setIsOpen = propSetIsOpen || setInternalIsOpen;

  // Auto-scroll
  useEffect(() => {
    if (isOpen && !isMinimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen, isMinimized]);

  // Initialize Audio Context on interaction
  const ensureAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };

  const handleSendMessage = async (text: string = inputText, shouldSpeak: boolean = autoSpeak) => {
    if (!text.trim()) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', text };
    const conversation = [...messages.filter(message => message.id !== 'init'), userMsg]
      .slice(-20)
      .map(({ role, text }) => ({ role, text }));
    setMessages(prev => [...prev, userMsg]);
    setInputText('');
    setIsLoading(true);

    try {
      const responseText = await askSignageAssistant(conversation);

      if (responseText) {
          const aiMsg: Message = { id: (Date.now() + 1).toString(), role: 'model', text: responseText };
          setMessages(prev => [...prev, aiMsg]);
          
          if (shouldSpeak) {
              speakResponse(responseText);
          }
      }
    } catch (error) {
      console.error("Chat Error:", error);
      const message = error instanceof Error ? error.message : "Sorry, I'm having trouble connecting right now.";
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: message }]);
    } finally {
      setIsLoading(false);
    }
  };

  const speakResponse = async (text: string) => {
     try {
        const base64Audio = await generateSpeech(text);
        if (base64Audio) {
            ensureAudioContext();
            if (audioContextRef.current) {
                const audioBuffer = await decodeAudioData(decode(base64Audio), audioContextRef.current);
                const source = audioContextRef.current.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(audioContextRef.current.destination);
                source.start();
            }
        }
     } catch (e) {
         console.error("TTS Error", e);
     }
  };

  const toggleListening = () => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        notify('Speech recognition is not supported in this browser.', 'warning');
        return;
    }

    if (isListening) {
        setIsListening(false);
        return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    
    recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
            // If used voice, we auto-speak the reply
            setAutoSpeak(true);
            handleSendMessage(transcript, true);
        }
    };

    recognition.start();
  };

  // Audio Decoding Helpers
  function decode(base64: string) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  async function decodeAudioData(data: Uint8Array, ctx: AudioContext): Promise<AudioBuffer> {
     // Copy into a guaranteed ArrayBuffer. Newer TypeScript versions model a
     // Uint8Array's backing store as ArrayBufferLike (which may be shared),
     // while Web Audio deliberately accepts only a transferable ArrayBuffer.
     const buffer = Uint8Array.from(data).buffer;
     try {
         return await ctx.decodeAudioData(buffer);
     } catch (e) {
         console.error("Audio decode failed", e);
         throw e;
     }
  }

  if (!isOpen) {
      return (
          <button 
            onClick={() => setIsOpen(true)}
            className="fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] right-3 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-900/40 transition-all hover:scale-110 hover:bg-blue-500 lg:bottom-6 lg:right-6 lg:h-14 lg:w-14"
            title="Open Assistant"
          >
              <Bot className="w-7 h-7" />
          </button>
      );
  }

  return (
    <div 
        className={`fixed right-3 z-50 flex flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl transition-all duration-300 md:right-6 ${isMinimized ? 'bottom-[calc(6rem+env(safe-area-inset-bottom))] h-14 w-[calc(100vw-1.5rem)] max-w-72 lg:bottom-6' : 'bottom-[calc(6rem+env(safe-area-inset-bottom))] h-[min(64dvh,540px)] w-[calc(100vw-1.5rem)] lg:bottom-6 lg:h-[550px] lg:w-96'}`}
    >
        {/* Header */}
        <div className="flex items-center justify-between p-3 bg-gray-800 border-b border-gray-700 cursor-pointer" onClick={() => isMinimized && setIsMinimized(false)}>
            <div className="flex items-center gap-2 text-white font-semibold">
                <div className="p-1.5 bg-blue-600 rounded-lg">
                    <Sparkles className="w-4 h-4 text-white" />
                </div>
                <span>Pro Guide</span>
            </div>
            <div className="flex items-center gap-1">
                <button 
                    onClick={(e) => { e.stopPropagation(); setIsMinimized(!isMinimized); }}
                    className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                >
                    <ChevronDown className={`w-4 h-4 transition-transform ${isMinimized ? 'rotate-180' : ''}`} />
                </button>
                <button 
                    onClick={(e) => { e.stopPropagation(); setIsOpen(false); setIsMinimized(false); }}
                    className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>

        {/* Chat Body */}
        {!isMinimized && (
            <>
                <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-950/50 custom-scrollbar">
                    {messages.map((msg) => (
                        <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                            <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center ${msg.role === 'user' ? 'bg-gray-700' : 'bg-blue-900/50 border border-blue-500/30'}`}>
                                {msg.role === 'user' ? <UserIcon className="w-4 h-4 text-gray-300" /> : <Bot className="w-4 h-4 text-blue-300" />}
                            </div>
                            <div className={`p-3 rounded-lg text-sm max-w-[80%] leading-relaxed shadow-sm ${
                                msg.role === 'user' 
                                ? 'bg-gray-800 text-white rounded-tr-none' 
                                : 'bg-blue-900/20 border border-blue-500/20 text-blue-100 rounded-tl-none'
                            }`}>
                                {/* Simple Markdown-ish rendering */}
                                {msg.text.split('\n').map((line, i) => (
                                    <p key={i} className={`min-h-[1.2em] ${line.startsWith('**') ? 'font-bold text-white mb-1' : 'mb-1'}`}>
                                        {line.replace(/\*\*/g, '')}
                                    </p>
                                ))}
                            </div>
                        </div>
                    ))}
                    {isLoading && (
                        <div className="flex gap-3">
                             <div className="w-8 h-8 rounded-full bg-blue-900/50 border border-blue-500/30 flex-shrink-0 flex items-center justify-center">
                                <Bot className="w-4 h-4 text-blue-300" />
                            </div>
                            <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg p-3 rounded-tl-none">
                                <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Footer */}
                <div className="p-3 bg-gray-800 border-t border-gray-700">
                    <div className="relative flex items-center gap-2">
                        <div className="relative flex-1">
                            <input 
                                type="text" 
                                value={inputText}
                                onChange={(e) => setInputText(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                                placeholder="Ask how to..."
                                className="w-full bg-gray-900 border border-gray-600 rounded-full pl-4 pr-10 py-2.5 text-sm text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                            />
                            <button 
                                onClick={toggleListening}
                                className={`absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all ${
                                    isListening 
                                    ? 'bg-red-500 text-white animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]' 
                                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                                }`}
                                title="Voice Input"
                            >
                                <Mic className="w-4 h-4" />
                            </button>
                        </div>
                        <button 
                            onClick={() => handleSendMessage()}
                            disabled={isLoading || !inputText.trim()}
                            className="p-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-lg"
                        >
                            <Send className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="flex justify-between items-center mt-2 px-1">
                        <button 
                           onClick={() => setAutoSpeak(!autoSpeak)}
                           className={`text-[10px] flex items-center gap-1 ${autoSpeak ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
                        >
                            {autoSpeak ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
                            {autoSpeak ? 'Voice On' : 'Voice Off'}
                        </button>
                        <span className="text-[10px] text-gray-600">Powered by Gemini 2.5</span>
                    </div>
                </div>
            </>
        )}
    </div>
  );
};

export default Assistant;
