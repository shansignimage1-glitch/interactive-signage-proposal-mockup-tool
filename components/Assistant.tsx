import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, GenerateContentResponse } from "@google/genai";
import { MessageCircle, X, Send, Mic, Volume2, VolumeX, Loader2, Sparkles, Bot, ChevronDown, User as UserIcon } from 'lucide-react';

const SYSTEM_INSTRUCTION = `You are the expert AI tutor for "SignagePro", a professional signage mockup tool.
Your goal is to teach users how to use the application step-by-step.
Be concise, friendly, and encouraging. Use short paragraphs and bullet points.

App Features you must explain when asked:
1. **Getting Started**: Upload a background image (building facade) using the "New Image" button or the Camera.
2. **Signs**: Add signs with the "+" button. Select a sign to edit its properties.
3. **3D Extrusion**: Enable "Extrusion 3D" in properties to give depth to the logo. Adjust depth and angle to match the building's perspective.
4. **Perspective**: Drag the 4 corners of a sign to match the perspective of the wall. This is critical for realism.
5. **Dimensions**: Use the Dimensions tool (Line or Box) to annotate sizes on the wall.
6. **Title Block**: Switch to the "Title Block" tab to fill in project info (Client, Address, Scale) and view the final sheet layout.
7. **Export**: Use the blue "Export PDF/PNG" button to save your work.
8. **Magic Cleanup**: Use the Eraser icon to remove unwanted objects (like old signs or graffiti) from the background using Generative AI.
9. **Navigation**: Scroll to zoom. Middle-click, Shift+Click, or Left-Click (in Title Block view) to pan the canvas.

If the user asks about something not related to the app, politely steer them back to SignagePro.`;

interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
}

interface AssistantProps {
  isOpen?: boolean;
  setIsOpen?: (isOpen: boolean) => void;
  apiKey?: string;
}

const Assistant: React.FC<AssistantProps> = ({ isOpen: propIsOpen, setIsOpen: propSetIsOpen, apiKey }) => {
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
  const aiRef = useRef<GoogleGenAI | null>(null);
  const chatSessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const isOpen = propIsOpen !== undefined ? propIsOpen : internalIsOpen;
  const setIsOpen = propSetIsOpen || setInternalIsOpen;

  // Initialize AI — reinitialize whenever the resolved key changes
  useEffect(() => {
    const key = apiKey || process.env.API_KEY;
    if (key) {
      aiRef.current = new GoogleGenAI({ apiKey: key });
      chatSessionRef.current = aiRef.current.chats.create({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
        }
      });
    } else {
      aiRef.current = null;
      chatSessionRef.current = null;
    }
  }, [apiKey]);

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
    if (!text.trim() || !aiRef.current) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', text };
    setMessages(prev => [...prev, userMsg]);
    setInputText('');
    setIsLoading(true);

    try {
      const result: GenerateContentResponse = await chatSessionRef.current.sendMessage({ message: text });
      const responseText = result.text;

      if (responseText) {
          const aiMsg: Message = { id: (Date.now() + 1).toString(), role: 'model', text: responseText };
          setMessages(prev => [...prev, aiMsg]);
          
          if (shouldSpeak) {
              speakResponse(responseText);
          }
      }
    } catch (error) {
      console.error("Chat Error:", error);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: "Sorry, I'm having trouble connecting right now." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const speakResponse = async (text: string) => {
     if (!aiRef.current) return;
     
     try {
        const response = await aiRef.current.models.generateContent({
            model: 'gemini-2.5-flash-preview-tts',
            contents: [{ parts: [{ text }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: 'Aoede' }
                    }
                }
            }
        });

        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
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
        alert("Speech recognition is not supported in this browser.");
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
     const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
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
            className="fixed bottom-6 right-6 z-50 w-14 h-14 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg shadow-blue-900/40 flex items-center justify-center transition-all hover:scale-110"
            title="Open Assistant"
          >
              <Bot className="w-7 h-7" />
          </button>
      );
  }

  return (
    <div 
        className={`fixed right-4 md:right-6 z-50 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col transition-all duration-300 overflow-hidden ${isMinimized ? 'bottom-6 w-72 h-14' : 'bottom-6 w-[90vh] md:w-96 h-[60vh] md:h-[550px]'}`}
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