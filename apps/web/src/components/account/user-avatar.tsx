/**
 * A member's Discord avatar with initials as the fallback. Server- and client-safe (the avatar
 * primitives are client components).
 */
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

/** "Zezima the Great" → "ZT"; one word → its first two letters. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '?').slice(0, 2).toUpperCase();
  return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
}

export function UserAvatar({
  name,
  image,
  size = 'sm',
  className,
}: {
  name: string;
  image: string | null;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}) {
  return (
    <Avatar size={size} className={className}>
      {image && <AvatarImage src={image} alt="" />}
      <AvatarFallback>{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}
