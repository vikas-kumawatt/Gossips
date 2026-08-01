import React from "react";
import { Icons } from "../components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

const MessageContextMenu = ({ 
  contextMenu, 
  selectedMessage, 
  onClose, 
  onAction 
}) => {
  if (!contextMenu) return null;

  return (
    <DropdownMenu open={!!contextMenu} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <div 
          className="fixed inset-0 z-40" 
          style={{ pointerEvents: 'none' }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent sheetTitle="Message"
        align="end"
        className="bg-neutral-900 border-neutral-700 rounded-2xl w-56 p-2 z-50"
        style={{
          position: 'fixed',
          left: Math.min(contextMenu.x || 0, window.innerWidth - 224),
          top: Math.min(contextMenu.y || 0, window.innerHeight - 300),
        }}
      >
        {selectedMessage?.isOwn && selectedMessage?.content && !selectedMessage?.isDeleted && (
          <DropdownMenuItem
            onClick={() => onAction('edit')}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
          >
            <span>Edit</span>
            <Icons.edit className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => onAction('reply')}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>Reply</span>
          <Icons.reply3 className="w-4 h-4" />
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onAction('react')}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>React</span>
          <Icons.smile className="w-4 h-4" />
        </DropdownMenuItem>
        {selectedMessage?.content && (
          <DropdownMenuItem
            onClick={() => onAction('copy')}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
          >
            <span>Copy</span>
            <Icons.copy className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => onAction('forward')}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>Forward</span>
          <Icons.share className="w-4 h-4" />
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onAction('pin')}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer"
        >
          <span>{selectedMessage?.isPinned ? 'Unpin' : 'Pin'}</span>
          <Icons.pin className="w-4 h-4" />
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-neutral-700 my-2" />
        {selectedMessage?.isOwn && !selectedMessage?.isDeleted && (
          <DropdownMenuItem
            onClick={() => onAction('unsend')}
            className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
          >
            <span>Unsend</span>
            <Icons.delete className="w-4 h-4" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => onAction('delete')}
          className="flex justify-between items-center p-3 hover:bg-neutral-800 rounded-xl cursor-pointer text-red-500"
        >
          <span>Delete for me</span>
          <Icons.delete className="w-4 h-4" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default MessageContextMenu;